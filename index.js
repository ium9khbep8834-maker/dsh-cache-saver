/**
 * dsh-cache-saver — shrink the fixed prompt prefix and make per-request cost
 * observable.
 *
 * Two levers, both measured by the same report:
 *
 * 1. Schema slimming. Every request ships the full JSON Schema of every visible
 *    tool; large MCP tool sets (e.g. `rea`: ~207 tools, ~690 KB of schemas)
 *    dominate the prefix. For each Agent we register a *scoped* copy of selected
 *    tools whose `parameters` is a compact but callable projection (top-level
 *    names and primitive types survive; deep nesting, `examples`, `default`, and
 *    multi-KB union bodies collapse). Scoped tools shadow global ones, and
 *    `execute`/`output`/`finalizeContent` keep pointing at the original
 *    implementation, so dispatch is unchanged.
 *
 * 2. Attribution. Tool results are the part of the conversation that gets
 *    re-sent on every later step, so the plugin observes (never mutates)
 *    `tools/result` for per-tool result volume and duplicate calls, and
 *    `session/event` (`assistant/message`) for the provider's own `usage`: billed
 *    input, cache reads, cache writes and new full-price content. From those it
 *    derives an equivalent-token cost: `0.1 × cache_read + new_tokens` per step
 *    (cache-hit price ratio 0.1 is the whole reason the prefix matters).
 *
 * Contract notes (verified against the installed DSH 0.2.1-rc.2):
 * - `agent/created` is a serial, awaited event; listeners must never throw.
 * - Per-agent registrations belong on `agent.ctx`, wrapped in one
 *   `agent.ctx.effect()` whose disposer is also kept by the plugin effect.
 * - `tools/result` observers receive `(exec, result)`; `exec` carries
 *   `{ callId, name, arguments, agent, signal }` and `result` carries
 *   `{ content: ContentBlock[], isError, value }`. Observers cannot mutate.
 * - `session/event` handlers receive `(session, event)`; for
 *   `event.type === 'assistant/message'`, `event.data.usage` is the provider's
 *   `{ inputTokens (uncached), cacheReadTokens, cacheWriteTokens, outputTokens }`.
 * - `ctx.tools.get(name)` (no scope) reads the global definition;
 *   `ctx.tools.schemas(scope)` returns that scope's model-facing schemas.
 */

const NAME = 'cache-saver';

/** Tool this plugin adds for its own reporting. */
const STATUS_TOOL = 'cache_saver_status';

/** Schema keywords that only matter to editors/tooling, never to a caller. */
const NEVER_KEEP = new Set([
  'examples',
  'example',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$schema',
  '$id',
  '$anchor',
  'title',
]);

const DEFAULTS = {
  /** Only tools whose name starts with one of these prefixes are slimmed. */
  shadowPrefixes: ['mcp__rea__'],
  /** Exact tool names that are never slimmed. */
  keepFull: [
    'mcp__rea__inspect_web_page',
    'mcp__rea__list_names',
    'mcp__rea__list_procedures',
    'mcp__rea__procedure_pseudo_code',
    'mcp__rea__procedure_assembly',
    'mcp__rea__analyze_function',
    'mcp__rea__search_procedures',
    'mcp__rea__search_strings',
  ],
  /** Slimming is skipped when a schema is already this small (chars). */
  minChars: 700,
  /** A slimmed schema should not exceed this (chars). */
  maxSchemaChars: 800,
  /** Deepest nesting level kept; deeper object schemas become `additionalProperties`. */
  maxDepth: 3,
  /** Keep descriptions at the top of the schema up to this many chars. */
  topDescriptionChars: 140,
  /** Keep descriptions one level down up to this many chars. */
  nestedDescriptionChars: 60,
  /** Deeper descriptions are dropped. */
  descriptionDepth: 1,
  /** Tool descriptions longer than this are clamped (0 disables clamping). */
  maxDescriptionChars: 260,
  /** Union branches kept per keyword before the fan-out is truncated. */
  maxBranches: 4,
  /** Tool results above this many tokens are counted as "large" in the report. */
  bigResultTokens: 6000,
  /** Records kept per agent for the step timeline. */
  maxStepSamples: 60,
  /** Skip registration entirely (dry run) — useful to compare sizes only. */
  dryRun: false,
};

const HISTORY_BUCKETS = ['user', 'assistant', 'toolResult', 'toolCall', 'reasoning', 'other'];

function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue;
      if (key === 'shadowPrefixes' || key === 'keepFull') {
        if (Array.isArray(value)) config[key] = value.filter((item) => typeof item === 'string');
        continue;
      }
      if (typeof DEFAULTS[key] === 'boolean') {
        config[key] = Boolean(value);
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        config[key] = value;
        continue;
      }
      if (typeof value === 'string') config[key] = value;
    }
  }
  config.maxDepth = Math.max(0, Math.min(6, Math.trunc(config.maxDepth)));
  config.descriptionDepth = Math.max(0, config.descriptionDepth);
  config.minChars = Math.max(0, config.minChars);
  config.maxSchemaChars = Math.max(200, config.maxSchemaChars);
  config.maxBranches = Math.max(1, config.maxBranches);
  config.bigResultTokens = Math.max(500, config.bigResultTokens);
  config.maxStepSamples = Math.max(5, Math.min(500, config.maxStepSamples));
  return config;
}

/** JSON length in chars (undefined payloads count as 0). */
function measure(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text.length : 0;
  } catch {
    return 0;
  }
}

/** Clamp prose to `max` chars, preferring a sentence/line boundary. */
function clampText(value, max) {
  if (typeof value !== 'string' || !(max > 0)) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  let cut = -1;
  for (const marker of ['\n', '. ', '; ', '。', '；']) {
    const at = slice.lastIndexOf(marker);
    if (at > cut) cut = at;
  }
  const base = cut > max * 0.45 ? slice.slice(0, cut + 1) : slice;
  return `${base.trimEnd()} …`;
}

/** Collapse an object schema past `maxDepth` into a callable stub. */
function collapseLeaf(node, settings) {
  const declared = node && typeof node.type === 'string' ? node.type : undefined;
  const kind = declared ?? (node && node.properties ? 'object' : undefined);
  const description = clampText(node?.description, settings.leafDescriptionChars);
  const out = kind === 'object' ? { type: 'object', additionalProperties: true } : kind ? { type: kind } : { type: 'object', additionalProperties: true };
  if (kind === 'object') out.description = description ? `${description} (nested fields omitted)` : 'Nested fields omitted by cache-saver.';
  else if (description) out.description = description;
  if (Array.isArray(node?.enum) && node.enum.length > 0 && node.enum.length <= 12) out.enum = node.enum;
  return out;
}

const MAP_OF_SCHEMAS = new Set(['$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const SINGLE_SCHEMA = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);
const UNION_SCHEMAS = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);

/** One compaction pass over a schema node at `depth`. */
function walkSchema(node, depth, settings) {
  if (node === null || typeof node !== 'object') return node === undefined ? node : node;
  if (Array.isArray(node)) return node.map((item) => walkSchema(item, depth, settings));
  if (depth > settings.maxDepth) return collapseLeaf(node, settings);

  const out = {};
  let trailingNote;
  const keys = Object.keys(node);

  for (const key of keys) {
    const value = node[key];
    if (NEVER_KEEP.has(key)) continue;

    if (key === 'description') {
      const limit = depth === 0 ? settings.topDescriptionChars : depth <= settings.descriptionDepth ? settings.nestedDescriptionChars : -1;
      const text = limit > 0 ? clampText(value, limit) : undefined;
      if (text) out.description = text;
      continue;
    }

    if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = walkSchema(propSchema, depth + 1, settings);
      }
      out.properties = properties;
      continue;
    }

    if (MAP_OF_SCHEMAS.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const mapped = {};
      for (const [entryName, entrySchema] of Object.entries(value)) {
        mapped[entryName] = walkSchema(entrySchema, depth + 1, settings);
      }
      out[key] = mapped;
      continue;
    }

    if (SINGLE_SCHEMA.has(key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = walkSchema(value, depth + 1, settings);
      else if (typeof value === 'boolean' || value === undefined) out[key] = value;
      continue;
    }

    if (UNION_SCHEMAS.has(key)) {
      if (!Array.isArray(value)) continue;
      let branches = value.map((branch) => walkSchema(branch, depth + 1, settings));
      if (branches.length > settings.maxBranches) {
        branches = branches.slice(0, settings.maxBranches);
        trailingNote = `${key} variants truncated to ${settings.maxBranches} by cache-saver; pass fields explicitly.`;
      }
      out[key] = branches;
      continue;
    }

    if (key === 'required' && Array.isArray(value)) {
      out.required = value.filter((item) => typeof item === 'string');
      continue;
    }

    out[key] = value;
  }

  if (Array.isArray(out.required)) {
    if (out.properties && typeof out.properties === 'object') {
      out.required = out.required.filter((name) => Object.prototype.hasOwnProperty.call(out.properties, name));
    }
    if (out.required.length === 0) delete out.required;
  }

  if (trailingNote) {
    out.description = out.description ? `${out.description} ${trailingNote}` : trailingNote;
  }
  return out;
}

/** Guarantee an object root so the model always sees a callable parameter list. */
function normalizeRoot(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = { ...schema };
  if (typeof out.type !== 'string') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object') out.properties = {};
  if (out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

/** Last resort: keep only the top-level parameter names and coarse types. */
function skeletonRoot(schema, settings) {
  const root = normalizeRoot(schema);
  const properties = {};
  for (const [name, propSchema] of Object.entries(root.properties ?? {})) {
    const kind = typeof propSchema?.type === 'string' ? propSchema.type : propSchema?.properties ? 'object' : 'string';
    const entry = { type: kind };
    const description = clampText(propSchema?.description, settings.skeletonDescriptionChars);
    if (description) entry.description = description;
    properties[name] = entry;
  }
  const out = { type: 'object', properties, additionalProperties: false };
  const rootDescription = clampText(root.description, settings.topDescriptionChars);
  if (rootDescription) out.description = rootDescription;
  if (Array.isArray(root.required) && root.required.length > 0) {
    out.required = root.required.filter((name) => Object.prototype.hasOwnProperty.call(properties, name));
    if (out.required.length === 0) delete out.required;
  }
  return out;
}

/**
 * Project one tool definition into a cheaper, still-callable definition.
 * Returns `undefined` when the tool should be left exactly as it is.
 */
function slimToolDefinition(definition, config) {
  const parameters = definition?.parameters;
  const before = measure(parameters);
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined;

  const settings = {
    minChars: config.minChars,
    maxSchemaChars: config.maxSchemaChars,
    maxDepth: config.maxDepth,
    topDescriptionChars: config.topDescriptionChars,
    nestedDescriptionChars: config.nestedDescriptionChars,
    descriptionDepth: config.descriptionDepth,
    maxBranches: config.maxBranches,
    leafDescriptionChars: 80,
    skeletonDescriptionChars: 70,
  };

  const description = typeof definition.description === 'string' ? definition.description : '';
  const slimDescription = config.maxDescriptionChars > 0 ? clampText(description, config.maxDescriptionChars) : description;

  const schemaChanged = before > config.minChars;
  const descriptionChanged = slimDescription !== undefined && slimDescription !== description;

  if (!schemaChanged && !descriptionChanged) return undefined;

  let schema = parameters;
  let after = before;

  if (schemaChanged) {
    let chosen;
    for (let depth = config.maxDepth; depth >= 0; depth -= 1) {
      const candidate = normalizeRoot(walkSchema(parameters, 0, { ...settings, maxDepth: depth }));
      const size = measure(candidate);
      chosen = { schema: candidate, size };
      if (size <= config.maxSchemaChars) break;
    }
    if (!chosen || chosen.size > config.maxSchemaChars) {
      const candidate = skeletonRoot(parameters, settings);
      chosen = { schema: candidate, size: measure(candidate) };
    }
    if (chosen.size >= before) {
      // Slimming did not help; keep the original schema instead of a worse one.
      schema = parameters;
      after = before;
    } else {
      schema = chosen.schema;
      after = chosen.size;
    }
  }

  const nextDescription = descriptionChanged ? slimDescription : description;
  const next = { ...definition, description: nextDescription, parameters: schema };
  const totalBefore = before + description.length;
  const totalAfter = after + (nextDescription?.length ?? 0);
  if (totalAfter >= totalBefore) return undefined;
  return { definition: next, before: totalBefore, after: totalAfter };
}

function matchesPrefix(name, prefixes) {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/** Chars of model-facing text in one tool result. */
function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block === 'string') chars += block.length;
    else if (block && typeof block.text === 'string') chars += block.text.length;
  }
  return chars;
}

/** Stable, cheap fingerprint of tool arguments (duplicate-call detection). */
function fingerprint(value) {
  let text;
  try {
    text = JSON.stringify(value, (_key, inner) => {
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return inner;
      const sorted = {};
      for (const key of Object.keys(inner).sort()) sorted[key] = inner[key];
      return sorted;
    });
  } catch {
    text = String(value);
  }
  if (typeof text !== 'string') text = String(text);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}

/** Classify one content block into a history bucket. */
function bucketOf(block, role) {
  if (typeof block === 'string') return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'other';
  const type = block && typeof block.type === 'string' ? block.type : undefined;
  if (type === 'tool-result') return 'toolResult';
  if (type === 'tool-call') return 'toolCall';
  if (type === 'reasoning') return 'reasoning';
  if (type === 'tool-addition' || type === 'tool-removal') return 'other';
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  if (role === 'tool') return 'toolResult';
  return 'other';
}

/** Chars of one content block (text only; non-text blocks count as 0 chars). */
function blockChars(block) {
  if (typeof block === 'string') return block.length;
  if (!block) return 0;
  if (typeof block.text === 'string') return block.text.length;
  if (typeof block.content === 'string') return block.content.length;
  if (Array.isArray(block.content)) return block.content.reduce((sum, inner) => sum + blockChars(inner), 0);
  if (block.type === 'image') return 0;
  return measure(block);
}

/** Per-message-bucket char counts for one durable-history snapshot. */
function measureMessages(messages) {
  const buckets = {};
  for (const bucket of HISTORY_BUCKETS) buckets[bucket] = 0;
  if (!Array.isArray(messages)) return { chars: 0, buckets, messages: 0, toolResults: 0, toolCalls: 0 };
  let chars = 0;
  let toolResults = 0;
  let toolCalls = 0;
  for (const message of messages) {
    const role = message && typeof message.role === 'string' ? message.role : 'other';
    const content = message?.content;
    if (typeof content === 'string') {
      const size = content.length;
      chars += size;
      buckets[bucketOf(content, role)] += size;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const size = blockChars(block);
      chars += size;
      buckets[bucketOf(block, role)] += size;
      const type = block && typeof block.type === 'string' ? block.type : undefined;
      if (type === 'tool-result') toolResults += 1;
      else if (type === 'tool-call') toolCalls += 1;
    }
  }
  return { chars, buckets, messages: messages.length, toolResults, toolCalls };
}

export const inject = ['tools'];

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const keepFull = new Set(config.keepFull);

  /** agentId -> { agent, createdAt, shadowed, before, after, tools[], steps[] } */
  const stats = new Map();
  /** agentId -> disposer of that agent's per-agent effect */
  const registrations = new Map();
  /** Ordered, bounded record of interesting events for the settings page. */
  const timeline = [];
  /** Aggregate tool-result attribution (all agents). */
  const results = {
    count: 0,
    tokens: 0,
    errors: 0,
    big: 0,
    maxTokens: 0,
    byTool: new Map(),
    duplicates: new Map(),
  };

  const log = (message) => {
    try {
      ctx.logger?.('cache-saver')?.debug?.(message);
    } catch {
      /* logging must never break activation */
    }
  };

  const note = (kind, text) => {
    timeline.push({ at: new Date().toISOString(), kind, text });
    if (timeline.length > 40) timeline.splice(0, timeline.length - 40);
  };

  /** Remember one tool result. Called from the observe-only `tools/result` hook. */
  const recordResult = (exec, result) => {
    const toolName = typeof exec?.name === 'string' ? exec.name : 'unknown';
    const chars = contentChars(result?.content);
    const tokens = Math.round(chars / 4);
    const isError = result?.isError === true;
    results.count += 1;
    results.tokens += tokens;
    if (isError) results.errors += 1;
    if (tokens > config.bigResultTokens) results.big += 1;
    if (tokens > results.maxTokens) results.maxTokens = tokens;

    let entry = results.byTool.get(toolName);
    if (!entry) {
      entry = { name: toolName, count: 0, tokens: 0, maxTokens: 0, errors: 0, duplicates: 0 };
      results.byTool.set(toolName, entry);
    }
    entry.count += 1;
    entry.tokens += tokens;
    if (tokens > entry.maxTokens) entry.maxTokens = tokens;
    if (isError) entry.errors += 1;

    const key = `${toolName}\u0000${fingerprint(exec?.arguments)}`;
    const seen = (results.duplicates.get(key) ?? 0) + 1;
    results.duplicates.set(key, seen);
    if (seen === 2) {
      entry.duplicates += 1;
      note('duplicate', `${toolName} called again with identical arguments`);
    }
    if (tokens > config.bigResultTokens) {
      note('big-result', `${toolName} result ≈ ${tokens} tokens (threshold ${config.bigResultTokens})`);
    }
  };

  /**
   * Composition of the durable history (share of chars per bucket). Used only for
   * the relative breakdown; absolute sizes come from the provider's own usage.
   */
  const composition = (session) => {
    const buckets = {};
    for (const bucket of HISTORY_BUCKETS) buckets[bucket] = 0;
    let chars = 0;
    try {
      const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined;
      const measured = measureMessages(messages);
      chars = measured.chars;
      if (chars > 0) {
        for (const bucket of HISTORY_BUCKETS) buckets[bucket] = Math.round((measured.buckets[bucket] / chars) * 1000) / 10;
      }
    } catch (error) {
      log(`history composition failed: ${String(error)}`);
    }
    return { chars, buckets };
  };

  /**
   * Remember one billed step from the provider's own usage numbers, which is the
   * only source that matches what the invoice bills (a char heuristic does not).
   */
  const recordStep = (agentId, session, data) => {
    const record = stats.get(agentId);
    if (!record || !data || typeof data !== 'object') return;
    const usage = data.usage;
    if (!usage || typeof usage !== 'object') return;
    // The provider reports the *uncached* input in `inputTokens`; the prompt size
    // is `inputTokens + cacheReadTokens (+ cacheWriteTokens)`.
    const freshTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
    const cacheWriteTokens = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
    const cachedTokens = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
    const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
    const inputTokens = freshTokens + cacheWriteTokens + cachedTokens;
    if (!(inputTokens > 0)) return;
    const newTokens = freshTokens + cacheWriteTokens;
    const costEquivTokens = Math.round(cachedTokens * 0.1 + freshTokens + cacheWriteTokens * 1.25);
    const snapshot = composition(session);
    record.steps.push({
      at: new Date().toISOString(),
      turn: Number.isFinite(data.turn) ? data.turn : null,
      step: Number.isFinite(data.step) ? data.step : record.steps.length + 1,
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      newTokens,
      costEquivTokens,
      hitPct: Math.round((cachedTokens / inputTokens) * 1000) / 10,
      buckets: snapshot.buckets,
    });
    if (record.steps.length > config.maxStepSamples) record.steps.splice(0, record.steps.length - config.maxStepSamples);
    record.contextTokens = inputTokens;
    record.cachedTokens = (record.cachedTokens ?? 0) + cachedTokens;
    record.inputTokens = (record.inputTokens ?? 0) + inputTokens;
    record.costEquivTokens = (record.costEquivTokens ?? 0) + costEquivTokens;
    record.newContentTokens = (record.newContentTokens ?? 0) + newTokens;
    record.stepsSeen = (record.stepsSeen ?? 0) + 1;
    if (inputTokens > (record.maxContextTokens ?? 0)) record.maxContextTokens = inputTokens;
    if (snapshot.chars > 0) {
      record.historyChars = snapshot.chars;
      record.buckets = snapshot.buckets;
    }
  };

  /** Register the slim shadow copies of every eligible tool into one agent scope. */
  const shadowAgent = (agent) => {
    if (!agent || typeof agent.id !== 'string' || registrations.has(agent.id)) return;
    const scope = agent.ctx;
    if (!scope?.tools) return;

    let disposeEffect;
    try {
      disposeEffect = scope.effect(() => {
        const disposers = [];
        const seen = new Set();
        const record = {
          agent: String(agent.id),
          createdAt: new Date().toISOString(),
          shadowed: 0,
          before: 0,
          after: 0,
          tools: [],
          steps: [],
          contextTokens: 0,
          maxContextTokens: 0,
          inputTokens: 0,
          cachedTokens: 0,
          historyChars: 0,
          buckets: null,
          costEquivTokens: 0,
          newContentTokens: 0,
          stepsSeen: 0,
        };

        let visible = [];
        try {
          visible = ctx.tools.schemas(scope) ?? [];
        } catch (error) {
          log(`schemas(scope) failed: ${String(error)}`);
          visible = [];
        }

        for (const schema of visible) {
          const toolName = schema?.name;
          if (typeof toolName !== 'string' || seen.has(toolName)) continue;
          seen.add(toolName);
          if (toolName === STATUS_TOOL || keepFull.has(toolName)) continue;
          if (!matchesPrefix(toolName, config.shadowPrefixes)) continue;

          let definition;
          try {
            definition = ctx.tools.get(toolName);
          } catch (error) {
            log(`get(${toolName}) failed: ${String(error)}`);
            continue;
          }
          if (!definition) continue;

          const slimmed = slimToolDefinition(definition, config);
          if (!slimmed) continue;

          if (!config.dryRun) {
            try {
              disposers.push(scope.tools.register(slimmed.definition));
            } catch (error) {
              log(`register(${toolName}) failed: ${String(error)}`);
              continue;
            }
          }

          record.shadowed += 1;
          record.before += slimmed.before;
          record.after += slimmed.after;
          record.tools.push({
            name: toolName,
            before: slimmed.before,
            after: slimmed.after,
            descriptionBefore: typeof definition.description === 'string' ? definition.description.length : 0,
            descriptionAfter: typeof slimmed.definition.description === 'string' ? slimmed.definition.description.length : 0,
          });
        }

        record.tools.sort((left, right) => right.before - right.after - (left.before - left.after));
        stats.set(agent.id, record);
        note('shadow', `${record.shadowed} tool schema(s) slimmed for agent ${String(agent.id).slice(0, 8)}`);

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* already disposed */
            }
          }
        };
      }, 'cache-saver:shadow');
    } catch (error) {
      log(`scope.effect failed: ${String(error)}`);
      return;
    }

    registrations.set(agent.id, () => {
      try {
        disposeEffect?.();
      } catch {
        /* already disposed */
      }
      stats.delete(agent.id);
      registrations.delete(agent.id);
    });
  };

  // Observe every tool result (global listener; `exec.agent` scopes the data).
  // `tools/result` is the documented observe-only hook for final outcomes.
  try {
    ctx.on('tools/result', (exec, result) => {
      try {
        recordResult(exec, result);
      } catch (error) {
        log(`tools/result observer failed: ${String(error)}`);
      }
    });
  } catch (error) {
    log(`tools/result listener failed: ${String(error)}`);
  }

  // Billed usage per model call. `assistant/message` carries the provider's own
  // `usage` (input/cacheRead/cacheWrite/output) — the only numbers that match the
  // invoice. Read-only observation; listeners never throw into the session.
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const agentId = session?.id;
        if (typeof agentId !== 'string' || !stats.has(agentId)) return;
        if (!event || event.type !== 'assistant/message') return;
        recordStep(agentId, session, event.data);
      } catch (error) {
        log(`session/event observer failed: ${String(error)}`);
      }
    });
  } catch (error) {
    log(`session/event listener failed: ${String(error)}`);
  }

  // Tear every per-agent registration down with the plugin itself: unloading a
  // plugin does not dispose `agent.ctx` registrations on its own.
  ctx.effect(
    () => () => {
      for (const dispose of [...registrations.values()]) dispose();
      registrations.clear();
      stats.clear();
    },
    'cache-saver:teardown',
  );

  ctx.on('agent/created', ({ agent }) => {
    try {
      shadowAgent(agent);
    } catch (error) {
      log(`agent/created handler failed: ${String(error)}`);
    }
  });

  // Agents that already exist when this plugin activates (e.g. an HMR reload)
  // are shadowed too, so the effect is visible without waiting for a new chat.
  // `agents` is optional so the plugin still activates in compositions without it.
  ctx.inject(['agents'], (agentsCtx) => {
    agentsCtx.effect(() => {
      try {
        for (const agent of agentsCtx.agents.list()) shadowAgent(agent);
      } catch (error) {
        log(`initial agent scan failed: ${String(error)}`);
      }
      return () => {};
    }, 'cache-saver:initial-scan');
  });

  /** Recorded agents, newest last; bounded so a long-lived process stays small. */
  const MAX_TRACKED_AGENTS = 24;
  const snapshotAgents = () => [...stats.values()].slice(-MAX_TRACKED_AGENTS);

  const HISTORICAL_CONTEXT_TOKENS = 200000;

  /** One aggregate view shared by the status tool and the settings page. */
  const buildReport = () => {
    const agents = snapshotAgents();
    let tools = 0;
    let before = 0;
    let after = 0;
    const perTool = new Map();
    for (const record of agents) {
      tools += record.shadowed;
      before += record.before;
      after += record.after;
      for (const item of record.tools) {
        const previous = perTool.get(item.name);
        if (previous === undefined) {
          perTool.set(item.name, { ...item });
        } else {
          previous.before += item.before;
          previous.after += item.after;
        }
      }
    }
    const savedChars = Math.max(0, before - after);
    const rows = [...perTool.values()]
      .map((item) => ({
        name: item.name,
        before: item.before,
        after: item.after,
        saved: item.before - item.after,
        savedPct: item.before > 0 ? Math.round(((item.before - item.after) / item.before) * 1000) / 10 : 0,
      }))
      .sort((left, right) => right.saved - left.saved);

    const resultRows = [...results.byTool.values()].sort((left, right) => right.tokens - left.tokens);

    const historyBuckets = {};
    for (const bucket of HISTORY_BUCKETS) historyBuckets[bucket] = 0;
    let steps = 0;
    let costEquivTokens = 0;
    let newContentTokens = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let contextTokens = 0;
    let maxContextTokens = 0;
    let historyChars = 0;
    let composedAgents = 0;
    for (const record of agents) {
      steps += record.stepsSeen ?? 0;
      costEquivTokens += record.costEquivTokens ?? 0;
      newContentTokens += record.newContentTokens ?? 0;
      inputTokens += record.inputTokens ?? 0;
      cachedTokens += record.cachedTokens ?? 0;
      contextTokens += record.contextTokens ?? 0;
      historyChars += record.historyChars ?? 0;
      if ((record.maxContextTokens ?? 0) > maxContextTokens) maxContextTokens = record.maxContextTokens;
      if (record.buckets) {
        composedAgents += 1;
        for (const bucket of HISTORY_BUCKETS) historyBuckets[bucket] += record.buckets[bucket] ?? 0;
      }
    }
    if (composedAgents > 0) {
      for (const bucket of HISTORY_BUCKETS) historyBuckets[bucket] = Math.round((historyBuckets[bucket] / composedAgents) * 10) / 10;
    }

    const recommendations = [];
    if (results.big > 0) {
      recommendations.push({
        level: 'warn',
        text: `${results.big} tool result(s) exceeded ${config.bigResultTokens} tokens (largest ${results.maxTokens}); lowering spill-policy.maxInlineTokens keeps that volume out of every later request.`,
      });
    }
    const duplicated = [...results.byTool.values()].filter((entry) => entry.duplicates > 0).sort((left, right) => right.duplicates - left.duplicates);
    if (duplicated.length > 0) {
      const top = duplicated.slice(0, 3).map((entry) => `${entry.name} ×${entry.duplicates}`).join(', ');
      recommendations.push({ level: 'info', text: `Identical repeated calls: ${top}. Each repeat re-sends the same arguments and result.` });
    }
    if (after > HISTORICAL_CONTEXT_TOKENS) {
      recommendations.push({
        level: 'info',
        text: `Slimmed schemas still total ${after} chars (≈${Math.round(after / 4)} tokens). Lowering maxSchemaChars further shrinks every request.`,
      });
    }
    if (contextTokens > 0 && steps > 0) {
      recommendations.push({
        level: 'info',
        text: `Average billed input ≈ ${Math.round(contextTokens / Math.max(1, agents.filter((record) => (record.stepsSeen ?? 0) > 0).length))} tokens over ${steps} step(s); cache hit ${inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 1000) / 10 : 0}%, equivalent input cost ≈ ${costEquivTokens} tokens.`,
      });
    }
    if (recommendations.length === 0) {
      recommendations.push({ level: 'ok', text: 'No large results, duplicate calls, or oversized schemas recorded yet.' });
    }

    return {
      plugin: NAME,
      version: '0.3.0',
      generatedAt: new Date().toISOString(),
      dryRun: config.dryRun,
      config: { ...config },
      totals: {
        agents: agents.length,
        tools,
        distinctTools: rows.length,
        charsBefore: before,
        charsAfter: after,
        savedChars,
        savedTokens: Math.round(savedChars / 4),
        savedPct: before > 0 ? Math.round((savedChars / before) * 1000) / 10 : 0,
        steps,
        costEquivTokens,
        newContentTokens,
        inputTokens,
        cachedTokens,
        hitPct: inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 1000) / 10 : 0,
        contextTokens,
        maxContextTokens,
        historyChars,
      },
      results: {
        count: results.count,
        tokens: results.tokens,
        errors: results.errors,
        big: results.big,
        maxTokens: results.maxTokens,
        byTool: resultRows.slice(0, 40),
      },
      history: {
        buckets: historyBuckets,
        chars: historyChars,
        agents: agents.map((record) => ({
          agent: record.agent,
          steps: record.stepsSeen ?? 0,
          contextTokens: record.contextTokens ?? 0,
          maxContextTokens: record.maxContextTokens ?? 0,
          costEquivTokens: record.costEquivTokens ?? 0,
          newContentTokens: record.newContentTokens ?? 0,
          inputTokens: record.inputTokens ?? 0,
          cachedTokens: record.cachedTokens ?? 0,
          hitPct: (record.inputTokens ?? 0) > 0 ? Math.round(((record.cachedTokens ?? 0) / record.inputTokens) * 1000) / 10 : 0,
        })),
      },
      recommendations,
      timeline: timeline.slice(-20),
      agents: agents.map((record) => ({
        agent: record.agent,
        createdAt: record.createdAt,
        tools: record.shadowed,
        charsBefore: record.before,
        charsAfter: record.after,
        savedChars: Math.max(0, record.before - record.after),
        savedTokens: Math.round(Math.max(0, record.before - record.after) / 4),
        steps: record.stepsSeen ?? 0,
        contextTokens: record.contextTokens ?? 0,
        costEquivTokens: record.costEquivTokens ?? 0,
        hiddenChars: Math.max(0, record.before - record.after) + (record.historyChars ?? 0),
      })),
      tools: rows.slice(0, 200),
    };
  };

  // The settings page reads this over HTTP from the same origin: read-only,
  // no request body, one exact path so no other route can reach it.
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => {
      let disposeRoute;
      try {
        disposeRoute = serverCtx.webServer.register({
          kind: 'exact',
          path: '/api/cache-saver/status',
          handler: (req, res) => {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
                res.end(JSON.stringify({ error: 'method not allowed' }));
                return;
              }
              const body = JSON.stringify(buildReport());
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(req.method === 'HEAD' ? undefined : body);
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: String(error) }));
            }
          },
        });
      } catch (error) {
        log(`route registration failed: ${String(error)}`);
      }
      return () => {
        try {
          disposeRoute?.();
        } catch {
          /* already disposed */
        }
      };
    }, 'cache-saver:http');
  });

  ctx.tools.register({
    name: STATUS_TOOL,
    description:
      'Report cache-saver status: how much tool-schema payload each request stopped shipping, how much tool-result volume entered the history, the equivalent input-token cost of recent steps, and tuning recommendations. Call it after changing cache-saver config or when a session feels expensive.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          agents: { type: 'number' },
          shadowedTools: { type: 'number' },
          schemaCharsBefore: { type: 'number' },
          schemaCharsAfter: { type: 'number' },
          savedChars: { type: 'number' },
          savedApproxTokens: { type: 'number' },
          toolResultTokens: { type: 'number' },
          bigResults: { type: 'number' },
          duplicateCalls: { type: 'number' },
          steps: { type: 'number' },
          costEquivTokens: { type: 'number' },
          inputTokens: { type: 'number' },
          cachedTokens: { type: 'number' },
          hitPct: { type: 'number' },
          maxContextTokens: { type: 'number' },
          largest: { type: 'string' },
          recommendations: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.summary === 'string' ? value.summary : JSON.stringify(value) }],
    },
    async execute() {
      const report = buildReport();
      const totals = report.totals;
      const duplicateCalls = report.results.byTool.reduce((sum, entry) => sum + entry.duplicates, 0);
      const summary = config.dryRun
        ? `cache-saver dry run: ${totals.tools} tool schema(s) across ${totals.agents} agent(s) would shrink from ${totals.charsBefore} to ${totals.charsAfter} chars (${totals.savedChars} saved).`
        : `cache-saver: ${totals.tools} tool schema(s) across ${totals.agents} agent(s) now ship ${totals.charsAfter} chars instead of ${totals.charsBefore} — ${totals.savedChars} chars (~${totals.savedTokens} tokens) saved per request. Tool results observed: ${report.results.count} (${report.results.tokens} tokens, ${report.results.big} above budget, ${duplicateCalls} duplicate call(s)). Billed steps: ${totals.steps}, input ${totals.inputTokens} tokens (cache hit ${totals.hitPct}%), equivalent input cost ≈ ${totals.costEquivTokens} tokens, largest context ${totals.maxContextTokens}.`;
      return {
        summary,
        agents: totals.agents,
        shadowedTools: totals.tools,
        schemaCharsBefore: totals.charsBefore,
        schemaCharsAfter: totals.charsAfter,
        savedChars: totals.savedChars,
        savedApproxTokens: totals.savedTokens,
        toolResultTokens: report.results.tokens,
        bigResults: report.results.big,
        duplicateCalls,
        steps: totals.steps,
        costEquivTokens: totals.costEquivTokens,
        inputTokens: totals.inputTokens,
        cachedTokens: totals.cachedTokens,
        hitPct: totals.hitPct,
        maxContextTokens: totals.maxContextTokens,
        largest: report.tools
          .slice(0, 5)
          .map((item) => `${item.name}: ${item.before}→${item.after}`)
          .join('; '),
        recommendations: report.recommendations.map((item) => `[${item.level}] ${item.text}`).join(' '),
      };
    },
  });
}

export { NAME, slimToolDefinition, normalizeConfig, measureMessages, contentChars, fingerprint };

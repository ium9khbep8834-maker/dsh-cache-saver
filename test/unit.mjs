/**
 * Dependency-free self test for dsh-cache-saver.
 * Run: node "D:\ds工作区\plugins\dsh-cache-saver\test\unit.mjs"
 *
 * It emulates the small part of the Cordis/DSh surface the plugin touches:
 * a global tool registry with scoped shadowing, `agent/created`, `ctx.effect`,
 * and `ctx.agents.list()`. Nothing here touches a real Harness.
 */

import assert from 'node:assert/strict';
import { apply, inject, slimToolDefinition, normalizeConfig } from '../index.js';

/* ------------------------------------------------------------------ fixtures */

/** A deliberately oversized, rea-shaped tool schema. */
function bigSchema() {
  const properties = {
    before: {
      type: 'object',
      description: 'The earlier complete normalized_result from inspect_web_page. '.repeat(4),
      properties: {
        browser: {
          type: 'object',
          properties: {
            product: { type: 'string', description: 'Browser product name. '.repeat(3) },
            protocol_version: { type: 'string' },
            revision: { type: 'string' },
            user_agent: { type: 'string' },
            js_version: { type: 'string' },
          },
          required: ['product', 'protocol_version'],
          additionalProperties: false,
        },
        target: {
          type: 'object',
          properties: {
            target_id: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            origin: { type: 'string' },
            attached: { type: ['boolean', 'null'] },
          },
        },
        completeness: {
          type: 'object',
          description: 'Completeness flags. '.repeat(10),
          properties: {
            status: { type: 'string', enum: ['complete_within_window', 'policy_filtered', 'attach_limited', 'truncated'] },
            conditions: { type: 'array', items: { type: 'string' } },
            excluded: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  section: { type: 'string' },
                  reason: { type: 'string' },
                  count: { type: ['integer', 'null'] },
                },
              },
            },
            dropped_events: {
              type: 'object',
              properties: Object.fromEntries(
                Array.from({ length: 8 }, (_, index) => [`counter_${index}`, { type: 'number', description: 'A counter. '.repeat(6) }]),
              ),
            },
          },
        },
        dom: {
          type: 'object',
          properties: {
            total_nodes: { type: 'number' },
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number' },
                  parent_index: { type: 'number' },
                  node_type: { type: 'number' },
                  node_name: { type: 'string' },
                  node_value_length: { type: 'number' },
                  attribute_names: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        network: {
          type: 'object',
          properties: {
            requests: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  request_id: { type: 'string' },
                  method: { type: 'string' },
                  status: { type: ['number', 'null'] },
                  redirects: { type: 'array', items: { $ref: '#/$defs/redirect' } },
                  initiator: { $ref: '#/$defs/initiator' },
                },
              },
            },
          },
        },
      },
      examples: [{ huge: 'example payload '.repeat(200) }],
    },
    after: { type: 'object', properties: { url: { type: 'string' }, dom: { type: 'object', properties: { nodes: { type: 'array', items: { $ref: '#/$defs/node' } } } } } },
    mode: {
      type: 'string',
      enum: ['exact', 'contains'],
      default: 'exact',
      oneOf: Array.from({ length: 9 }, (_, index) => ({
        type: 'object',
        properties: { variant: { type: 'string', const: `v${index}` }, payload: { type: 'object', properties: { deep: { type: 'object', properties: { deeper: { type: 'string' } } } } } },
      })),
    },
    selector: { type: 'string', description: 'CSS selector.' },
  };

  return {
    type: 'object',
    description: 'Compare two complete passive web captures. '.repeat(12),
    additionalProperties: false,
    required: ['before', 'after'],
    properties,
    $defs: {
      redirect: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          status: { type: 'number' },
          nested: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'object', properties: { d: { type: 'string' } } } } },
        },
      },
      initiator: { type: 'object', properties: { type: { type: 'string' }, url: { type: 'string' }, line: { type: 'number' } } },
      node: { type: 'object', properties: { index: { type: 'number' }, name: { type: 'string' } } },
    },
  };
}

function fakeDefinition(name, parameters, description) {
  const calls = [];
  return {
    calls,
    definition: {
      name,
      description: description ?? `Tool ${name} docs. `.repeat(80),
      parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute(args) {
        calls.push(args);
        return { ok: true };
      },
      presentCall: () => undefined,
    },
  };
}

/* -------------------------------------------------------------- fake runtime */

function makeHarness() {
  const globalTools = new Map();
  const scopedTools = new Map(); // scope -> Map(name -> def)
  const plugins = [];
  const listeners = new Map();
  const agents = [];

  const layerFor = (scope) => {
    if (!scope) return globalTools;
    if (!scopedTools.has(scope)) scopedTools.set(scope, new Map());
    return scopedTools.get(scope);
  };

  const merged = (scope) => {
    const result = new Map(globalTools);
    if (scope) for (const [name, def] of layerFor(scope)) result.set(name, def);
    return result;
  };

  const tools = {
    register(definition) {
      const scope = this.__scope;
      const layer = layerFor(scope);
      if (layer.has(definition.name)) throw new Error(`duplicate tool "${definition.name}" in one layer`);
      layer.set(definition.name, definition);
      return () => layer.delete(definition.name);
    },
    get(name, scope) {
      return merged(scope).get(name);
    },
    schemas(scope) {
      return [...merged(scope).values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
  };

  const routes = [];
  const ctx = {
    tools: Object.assign(Object.create({ __scope: undefined }), tools),
    logger: () => ({ debug() {} }),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    effect(factory) {
      plugins.push(factory());
      return () => {};
    },
    inject(deps, callback) {
      callback(ctx);
      return () => {};
    },
    agents: {
      list: () => agents,
    },
  };

  const createAgent = (id) => {
    const agent = {
      id,
      shadowDisposers: [],
      scopedListeners: new Map(),
      ctx: {
        effect(factory) {
          const disposer = factory();
          agent.shadowDisposers.push(disposer);
          return () => disposer?.();
        },
        on(event, handler) {
          const list = agent.scopedListeners.get(event) ?? [];
          list.push(handler);
          agent.scopedListeners.set(event, list);
          return () => {};
        },
        __scopedLayer: undefined,
      },
    };
    agent.ctx.__scopedLayer = layerFor(agent.ctx);
    agent.ctx.tools = {
      register(definition) {
        const layer = layerFor(agent.ctx);
        if (layer.has(definition.name)) throw new Error(`duplicate tool "${definition.name}" in one layer`);
        layer.set(definition.name, definition);
        return () => layer.delete(definition.name);
      },
      get: (name) => merged(agent.ctx).get(name),
      schemas: () => tools.schemas(agent.ctx),
    };
    agents.push(agent);
    return agent;
  };

  const emit = (event, ...args) => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };

  const emitAgent = async (agent, event, ...args) => {
    const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    for (const handler of agent.scopedListeners.get(event) ?? []) await handler(...args);
    if (next) await next();
  };

  return { ctx, globalTools, scopedTools, createAgent, emit, emitAgent, agents, plugins, routes };
}

/* ------------------------------------------------------------------- checks */

const config = normalizeConfig({});

// 1. The compactor alone: size drops, top-level names survive, $ref targets stay.
{
  const { definition } = fakeDefinition('mcp__rea__compare_web_captures', bigSchema());
  const before = JSON.stringify(definition.parameters).length;
  const slimmed = slimToolDefinition(definition, config);
  assert.ok(slimmed, 'oversized schema must be slimmed');
  const after = JSON.stringify(slimmed.definition.parameters).length;
  assert.ok(after < before / 4, `expected >4x shrink, got ${before} -> ${after}`);
  assert.ok(after <= config.maxSchemaChars + 400, `expected <= cap, got ${after}`);

  const top = slimmed.definition.parameters;
  assert.equal(top.type, 'object');
  for (const name of ['before', 'after', 'mode', 'selector']) {
    assert.ok(top.properties[name], `top-level parameter "${name}" must survive`);
  }
  assert.deepEqual(top.required, ['before', 'after']);
  assert.ok(slimmed.definition.execute, 'execute must be preserved');
  assert.ok(slimmed.definition.output, 'output must be preserved');
  assert.ok(slimmed.definition.description.length <= config.maxDescriptionChars + 2, 'description must be clamped');
  console.log(`single schema: ${before} -> ${after} chars (${(((before - after) / before) * 100).toFixed(1)}% smaller)`);
}

// 2. Small tools are untouched.
{
  const small = { name: 'mcp__rea__small', description: 'small', parameters: { type: 'object', properties: { query: { type: 'string' } } }, output: {}, execute: async () => ({}) };
  assert.equal(slimToolDefinition(small, config), undefined);
}

// 3. End-to-end through apply(): one agent gets scoped shadows, dispatch still works.
{
  const harness = makeHarness();
  const { definition: big, calls } = fakeDefinition('mcp__rea__compare_web_captures', bigSchema());
  const { definition: small } = fakeDefinition('mcp__rea__small_tool', { type: 'object', properties: { query: { type: 'string' } } }, 'Search one small thing.');
  const { definition: other } = fakeDefinition('read', { type: 'object', properties: { path: { type: 'string' } } }, 'Read a file.');
  for (const def of [big, small, other]) harness.globalTools.set(def.name, def);

  const globalsBefore = [...harness.globalTools.keys()].sort();

  apply(harness.ctx, {});
  assert.deepEqual(inject, ['tools']);

  const agent = harness.createAgent('session-1');
  harness.emit('agent/created', { agent });

  const shadowed = agent.ctx.__scopedLayer;
  assert.ok(shadowed.has('mcp__rea__compare_web_captures'), 'big rea tool must be shadowed');
  assert.ok(!shadowed.has('mcp__rea__small_tool'), 'small rea tool must not be shadowed');
  assert.ok(!shadowed.has('read'), 'non-prefixed tool must not be shadowed');
  const addedGlobally = [...harness.globalTools.keys()].filter((name) => !globalsBefore.includes(name)).sort();
  assert.deepEqual(addedGlobally, ['cache_saver_status'], 'only the status tool may be added globally');
  for (const name of globalsBefore) {
    assert.equal(harness.globalTools.get(name), (name === big.name ? big : name === small.name ? small : other), `global "${name}" must be untouched`);
  }

  const visible = harness.ctx.tools.schemas(agent.ctx);
  const visibleBig = visible.find((tool) => tool.name === 'mcp__rea__compare_web_captures');
  assert.ok(JSON.stringify(visibleBig.parameters).length * 4 < JSON.stringify(big.parameters).length, 'model-facing schema must shrink');
  assert.ok(visible.find((tool) => tool.name === 'cache_saver_status'), 'status tool must be registered globally');

  const shadowDef = shadowed.get('mcp__rea__compare_web_captures');
  await shadowDef.execute({ before: {}, after: {} });
  assert.equal(calls.length, 1, 'shadowed execute must reach the original implementation');

  // second agent/created for the same agent must be a no-op
  harness.emit('agent/created', { agent });
  assert.equal(shadowed.size, 1);

  // status tool reports the saving
  const statusTool = harness.globalTools.get('cache_saver_status');
  const report = await statusTool.execute({}, {});
  assert.ok(report.shadowedTools >= 1);
  assert.ok(report.savedChars > 0);
  assert.ok(report.summary.includes('cache-saver'));
  console.log(`status: ${report.summary}`);
  console.log(`largest: ${report.largest}`);
}

// 3b. The read-only HTTP route the settings page reads.
{
  const harness = makeHarness();
  const { definition: big } = fakeDefinition('mcp__rea__compare_web_captures', bigSchema());
  harness.globalTools.set(big.name, big);
  apply(harness.ctx, {});
  const agent = harness.createAgent('session-http');
  harness.emit('agent/created', { agent });

  assert.equal(harness.routes.length, 1, 'exactly one route must be registered');
  const route = harness.routes[0];
  assert.equal(route.path, '/api/cache-saver/status');
  assert.equal(route.kind, 'exact');

  const call = async (method) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: null,
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(body) {
        if (body !== undefined) chunks.push(String(body));
      },
    };
    await route.handler({ method }, res);
    return { status: res.statusCode, headers: res.headers, body: chunks.join('') };
  };

  const ok = await call('GET');
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type']), /application\/json/);
  assert.equal(ok.headers['cache-control'], 'no-store');
  const payload = JSON.parse(ok.body);
  assert.equal(payload.totals.agents, 1, 'the one shadowed agent must be reported');
  assert.ok(payload.totals.tools >= 1);
  assert.ok(payload.totals.savedChars > 0);
  assert.equal(payload.agents[0].agent, 'session-http');
  assert.equal(payload.tools[0].name, 'mcp__rea__compare_web_captures');
  assert.ok(payload.tools[0].savedPct > 50, 'the report must show a >50% drop for the fixture');
  assert.ok(Array.isArray(payload.config.shadowPrefixes), 'config must be reported');
  assert.ok(payload.generatedAt, 'report must carry a timestamp');

  const denied = await call('POST');
  assert.equal(denied.status, 405, 'the route is read-only');
  console.log(`http: ${payload.totals.tools} tool(s), ${payload.totals.savedChars} chars saved, ${payload.totals.savedTokens} tokens`);
}

// 4. dryRun registers nothing but still measures.
{
  const harness = makeHarness();
  const { definition: big } = fakeDefinition('mcp__rea__compare_web_captures', bigSchema());
  harness.globalTools.set(big.name, big);
  apply(harness.ctx, { dryRun: true });
  const agent = harness.createAgent('session-2');
  harness.emit('agent/created', { agent });
  assert.equal(agent.ctx.__scopedLayer.size, 0, 'dry run must not register shadows');
  const report = await harness.globalTools.get('cache_saver_status').execute({}, {});
  assert.ok(report.summary.includes('dry run'));
}

// 5. A throwing listener must not escape `agent/created` (it would abort creation).
{
  const harness = makeHarness();
  apply(harness.ctx, {});
  const broken = { id: 'session-3', get ctx() { throw new Error('boom'); } };
  assert.doesNotThrow(() => harness.emit('agent/created', { agent: broken }));
}

// 6. Observability: tool-result attribution, duplicate calls, large results.
{
  const harness = makeHarness();
  const { definition: big } = fakeDefinition('mcp__rea__compare_web_captures', bigSchema());
  harness.globalTools.set(big.name, big);
  apply(harness.ctx, { bigResultTokens: 1000 });
  const agent = harness.createAgent('session-observe');
  harness.emit('agent/created', { agent });

  const exec = (name, args) => ({ name, arguments: args, callId: 'c1', signal: { aborted: false } });
  const resultWith = (chars, isError) => ({ content: [{ type: 'text', text: 'x'.repeat(chars) }], isError: Boolean(isError) });

  harness.emit('tools/result', exec('mcp__rea__compare_web_captures', { a: 1, b: 2 }), resultWith(8000));
  harness.emit('tools/result', exec('mcp__rea__compare_web_captures', { b: 2, a: 1 }), resultWith(8000));
  harness.emit('tools/result', exec('read', { path: 'x.txt' }), resultWith(40));
  harness.emit('tools/result', exec('grep', { pattern: 'x' }), resultWith(20, true));

  const report = JSON.parse(
    await (async () => {
      const chunks = [];
      await harness.routes[0].handler({ method: 'GET' }, {
        writeHead() {},
        end(body) {
          if (body !== undefined) chunks.push(String(body));
        },
      });
      return chunks.join('');
    })(),
  );

  assert.equal(report.results.count, 4, 'every tool result must be counted');
  const bigEntry = report.results.byTool.find((entry) => entry.name === 'mcp__rea__compare_web_captures');
  assert.ok(bigEntry, 'the big tool must appear in the attribution table');
  assert.equal(bigEntry.count, 2);
  assert.equal(bigEntry.tokens, 4000, '8000 chars ≈ 2000 tokens per call');
  assert.equal(bigEntry.duplicates, 1, 'identical args (different key order) must be detected as one duplicate');
  assert.equal(report.results.errors, 1);
  assert.equal(report.results.big, 2, 'results over bigResultTokens must be flagged');
  assert.ok(
    report.recommendations.some((item) => item.text.includes('spill-policy.maxInlineTokens')),
    'a large-result recommendation must be produced',
  );
  assert.ok(report.timeline.some((item) => item.kind === 'shadow'));
  assert.ok(report.timeline.some((item) => item.kind === 'duplicate'));
  console.log(`attribution: ${report.results.count} result(s), ${report.results.tokens} tokens, ${report.results.big} big, ${bigEntry.duplicates} duplicate`);
}

// 7. Billed-usage attribution from `session/event` + history composition.
{
  const harness = makeHarness();
  apply(harness.ctx, {});
  const agent = harness.createAgent('session-steps');
  harness.emit('agent/created', { agent });

  const toolResultMessage = (chars) => ({
    role: 'user',
    content: [{ type: 'tool-result', text: 'r'.repeat(chars) }],
  });
  const session = {
    id: 'session-steps',
    deriveMessages: () => [toolResultMessage(3600)],
  };

  harness.emit('session/event', session, { type: 'step/start', data: { step: 1 } });
  // `usage.inputTokens` is the *uncached* part; the prompt is input + cacheRead.
  harness.emit('session/event', session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 500 } },
  });
  harness.emit('session/event', session, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, usage: { inputTokens: 40000, cacheReadTokens: 100000, outputTokens: 700 } },
  });
  // An unknown session must not be attributed to a recorded agent.
  harness.emit('session/event', { id: 'other-session' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage: { inputTokens: 1, cacheReadTokens: 1 } },
  });

  const report = JSON.parse(
    await (async () => {
      const chunks = [];
      await harness.routes[0].handler({ method: 'GET' }, {
        writeHead() {},
        end(body) {
          if (body !== undefined) chunks.push(String(body));
        },
      });
      return chunks.join('');
    })(),
  );

  assert.equal(report.totals.steps, 2, 'only the two billed steps of the recorded agent count');
  assert.equal(report.totals.inputTokens, 240000, 'billed input must come from provider usage');
  assert.equal(report.totals.cachedTokens, 100000, 'cache reads must come from provider usage');
  assert.equal(report.totals.hitPct, 41.7, 'hit rate must be cached/input');
  assert.equal(report.totals.newContentTokens, 140000, 'new content is input minus cached');
  assert.equal(report.totals.costEquivTokens, 150000, 'equivalent cost is cached*0.1 + new');
  assert.equal(report.totals.maxContextTokens, 140000, 'largest billed input wins');
  assert.equal(report.history.buckets.toolResult, 100, 'composition is a percentage mix');
  assert.equal(report.history.agents[0].inputTokens, 240000);
  console.log(
    `usage: ${report.totals.steps} steps, input ${report.totals.inputTokens}, cached ${report.totals.cachedTokens} (${report.totals.hitPct}%), cost≈${report.totals.costEquivTokens}`,
  );
}

console.log('all cache-saver checks passed');

/**
 * Dependency-free self test for the cache-saver client half.
 * Run: node "D:\ds工作区\plugins\dsh-cache-saver\test\client.mjs"
 *
 * It emulates the browser module table (`window.__ModuleLoader__`), a minimal
 * React (createElement + hooks), and the three Cordis services the bundle
 * touches (`effect`, `locale`, `slots`). Nothing here touches a real Harness.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* --------------------------------------------------------------- browser host */

const registered = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registered.push(definition);
    },
  },
};

/**
 * Collect every string/number rendered by `createElement` output, so assertions
 * can check the page content without a DOM.
 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  // A component element is not a leaf: render it (recursively) so text in the
  // component it returns is collected too.
  if (typeof node.component === 'function') {
    flatten(node.component(node.props), out);
    return out;
  }
  flatten(node.props?.children, out);
  return out;
}

let preloaded = [];

const reactStub = {
  createElement(type, props, ...children) {
    const label = typeof type === 'function' ? type.name : String(type);
    return { type: label, component: typeof type === 'function' ? type : null, props: { ...(props ?? {}), children } };
  },
  useState(initial) {
    const next = preloaded.length > 0 ? preloaded.shift() : initial;
    return [next, () => {}];
  },
  useEffect() {},
};

const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub;
  throw new Error(`unexpected module "${specifier}"`);
};

/* ---------------------------------------------------------------- load bundle */

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, '..', 'client.js'), 'utf8');
new Function('window', 'require', source)(globalThis.window, requireStub);

assert.equal(registered.length, 1, 'the bundle must register exactly one module');
const bundle = registered[0];
// The web boot imports the bundle by its package specifier, so the registered
// module id must be that same name (another id makes the loader run the bundle
// twice and fail with "duplicate factory registration").
const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
assert.equal(bundle.id, manifest.name, 'the module id must equal the package name');
const mod = bundle.factory(requireStub);
assert.equal(mod.name, 'cache-saver');
assert.deepEqual(mod.inject, ['slots', 'locale']);
assert.equal(typeof mod.apply, 'function');

/* A duplicate registration means this bundle already registered (boot script
 * plus an on-demand import); it must be swallowed, while any other loader
 * failure still escapes loudly. */
{
  let calls = 0;
  const duplicateWindow = {
    __ModuleLoader__: {
      load() {
        calls += 1;
        throw new Error(
          'client-modules: duplicate factory registration for "@local/dsh-cache-saver" (bundle executed twice without invalidate?)',
        );
      },
    },
  };
  new Function('window', 'require', source)(duplicateWindow, requireStub);
  assert.equal(calls, 1, 'the bundle must attempt registration exactly once');

  const failingWindow = { __ModuleLoader__: { load() { throw new Error('loader exploded'); } } };
  assert.throws(() => new Function('window', 'require', source)(failingWindow, requireStub), /loader exploded/);
}

/* ------------------------------------------------------------------- fake ctx */

function makeCtx() {
  const dictionaries = new Map();
  const slots = { injections: [], registrations: [] };
  const ctx = {
    effects: [],
    effect(factory, label) {
      assert.equal(typeof factory, 'function');
      this.effects.push({ label, disposer: factory() });
      return () => {};
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.set(namespace, dicts);
        return () => dictionaries.delete(namespace);
      },
      bind(namespace) {
        return (key) => dictionaries.get(namespace)?.zh?.[key] ?? key;
      },
    },
    slots: {
      inject(key, callback) {
        slots.injections.push(key);
        callback();
        return () => {};
      },
      register(options, component) {
        slots.registrations.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, dictionaries, slots };
}

/* -------------------------------------------------------- 1. registration shape */

{
  const { ctx, dictionaries, slots } = makeCtx();
  mod.apply(ctx);

  assert.equal(ctx.effects.length, 1, 'the dictionaries must live in one ctx.effect');
  assert.equal(ctx.effects[0].label, 'cache-saver:dictionaries');
  const dicts = dictionaries.get('cache-saver');
  assert.ok(dicts?.zh?.nav && dicts?.en?.nav, 'both dictionaries must be registered');
  assert.deepEqual(slots.injections, ['settings.section']);

  assert.equal(slots.registrations.length, 1);
  const { options, component } = slots.registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'cache-saver');
  assert.equal(options.order, 45, 'the page must sit between market (40) and bili (100)');
  assert.equal(options.locale, 'cache-saver');
  assert.equal(options.label(), '缓存节省', 'the label thunk must resolve through the locale');
  const injected = options.inject();
  assert.equal(typeof injected.t, 'function');
  assert.equal(injected.t('refresh'), '刷新');
  assert.equal(typeof component, 'function', 'the section must be a component');
  console.log('registration: settings.section / cache-saver / order 45 / label 缓存节省');
}

/* ----------------------------------------------------- 2. the page renders data */

const report = {
  plugin: 'cache-saver',
  version: '0.3.0',
  generatedAt: '2026-10-18T14:25:27.821Z',
  dryRun: false,
  config: {
    shadowPrefixes: ['mcp__rea__'],
    keepFull: [],
    defer: [],
    maxDescriptionChars: 400,
    minChars: 1000,
    maxSchemaChars: 2200,
    bigResultTokens: 4000,
  },
  totals: {
    agents: 1,
    tools: 112,
    distinctTools: 112,
    charsBefore: 704147,
    charsAfter: 158023,
    savedChars: 546124,
    savedTokens: 136531,
    savedPct: 77.6,
    steps: 40,
    contextTokens: 1_240_000,
    maxContextTokens: 152_000,
    inputTokens: 3_100_000,
    cachedTokens: 3_056_800,
    hitPct: 98.6,
    newContentTokens: 43_200,
    costEquivTokens: 1_645_000,
    costEquivSavedTokens: 136_531,
    resultTokens: 420_000,
    turnsWithResults: 12,
  },
  results: {
    count: 58,
    tokens: 420_000,
    big: 3,
    duplicateCalls: 4,
    errorTurns: 1,
    byTool: [
      { name: 'mcp__rea__analyze_function', count: 12, tokens: 210_000, maxTokens: 33_000, duplicates: 3, errors: 0 },
      { name: 'read', count: 26, tokens: 120_000, maxTokens: 12_000, duplicates: 1, errors: 0 },
    ],
  },
  history: {
    chars: 890_000,
    buckets: { user: 40_000, assistant: 60_000, toolResult: 620_000, toolCall: 90_000, reasoning: 60_000, other: 20_000 },
  },
  recommendations: [
    { level: 'warn', text: '工具结果仍是重发成本第一来源：建议把大结果封顶阈值降到 3000 tokens' },
    { level: 'info', text: 'schema 二轮瘦身可以再省约 1.2 万 tokens/请求' },
  ],
  timeline: [
    { at: '2026-10-18T14:25:12.068Z', kind: 'agent', text: 'shadowed 112 tools' },
    { at: '2026-10-18T14:26:00.000Z', kind: 'step', text: 'step 1: 2500 tokens context' },
  ],
  agents: [
    {
      agent: 'session-a5106a94',
      createdAt: '2026-10-18T14:25:12.068Z',
      tools: 112,
      steps: 40,
      contextTokens: 1_240_000,
      maxContextTokens: 152_000,
      costEquivTokens: 1_645_000,
      charsBefore: 704147,
      charsAfter: 158023,
      savedChars: 546124,
      savedTokens: 136531,
    },
  ],
  tools: [
    { name: 'mcp__rea__compare_web_captures', before: 155623, after: 1392, saved: 154231, savedPct: 99.1 },
    { name: 'mcp__rea__compare_application_versions', before: 28914, after: 1411, saved: 27503, savedPct: 95.1 },
  ],
};

{
  preloaded = [{ status: 'ready', report, error: null }, 0];
  const { slots } = makeCtx();
  mod.apply(makeCtx().ctx);
  const { component } = slots.registrations[0] ?? {};

  // apply() above ran against another ctx; re-register against a fresh one to grab the component.
  const harness = makeCtx();
  mod.apply(harness.ctx);
  const Section = harness.slots.registrations[0].component;

  preloaded = [{ status: 'ready', report, error: null }, 0];
  const tree = Section({ t: (key) => key, close() {} });
  const text = flatten(tree).join(' | ');
  assert.ok(text.includes('546,124'), 'saved chars must be shown');
  assert.ok(text.includes('136,531'), '≈tokens must be shown');
  assert.ok(text.includes('1,645,000'), 'the equivalent session cost must be shown');
  assert.ok(text.includes('98.6%'), 'the billed cache hit rate must be shown');
  assert.ok(text.includes('43,200'), 'new full-price content must be shown');
  assert.ok(text.includes('mcp__rea__compare_web_captures'), 'the top reductions must list tool names');
  assert.ok(text.includes('session-a5106a94'), 'per-agent rows must be listed');
  assert.ok(text.includes('mcp__rea__'), 'the config chip must echo the shadowed prefixes');
  assert.ok(text.includes('mcp__rea__analyze_function'), 'tool results must be attributed per tool');
  assert.ok(text.includes('封顶阈值降到 3000'), 'recommendations must be rendered');
  assert.ok(text.includes('当前上下文构成'), 'the history composition must be rendered');
  console.log(`page: ${text.slice(0, 120)}…`);
  void component;
}

/* ---------------------------------------------------------- 3. error and empty */

{
  preloaded = [{ status: 'error', report: null, error: 'HTTP 404' }, 0];
  const harness = makeCtx();
  mod.apply(harness.ctx);
  const Section = harness.slots.registrations[0].component;
  const tree = Section({ t: (key) => key, close() {} });
  const text = flatten(tree).join(' | ');
  assert.ok(text.includes('HTTP 404'), 'a failed fetch must be reported, not swallowed');
  assert.ok(text.includes('/api/cache-saver/status'), 'the error path must name the endpoint');
}

{
  preloaded = [
    {
      status: 'ready',
      error: null,
      report: { generatedAt: 'now', dryRun: false, config: {}, totals: { agents: 0, tools: 0 }, agents: [], tools: [] },
    },
    0,
  ];
  const harness = makeCtx();
  mod.apply(harness.ctx);
  const Section = harness.slots.registrations[0].component;
  const text = flatten(Section({ t: (key) => key, close() {} })).join(' | ');
  assert.ok(text.includes('还没有记录'), 'zero shadowed tools must render the empty state');
}

console.log('all cache-saver client checks passed');

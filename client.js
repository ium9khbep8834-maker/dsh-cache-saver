/**
 * Client half of cache-saver.
 *
 * Registers one page in the settings panel (`settings.section`) that renders the
 * host half's report: schema slimming, tool-result attribution, history
 * composition, the derived equivalent-token cost, and tuning recommendations.
 * Data comes from the plugin's own read-only route `GET /api/cache-saver/status`
 * (same origin), so the page needs no extra client service.
 *
 * This file is a host-injected ES module bundle: the web app hands it a
 * `require` for the shared module table (react and friends). It is not built by
 * the plugin itself and has no dependencies of its own.
 */

try {
  window.__ModuleLoader__.load({
    // The client module id MUST be the package name: the web boot imports this
    // bundle by its package specifier, and any other id registers a factory the
    // loader cannot find, so it executes the bundle a second time and the app
    // dies with "duplicate factory registration".
    id: '@local/dsh-cache-saver',
    factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const h = react.createElement;

    const NS = 'cache-saver';
    const name = 'cache-saver';
    const inject = ['slots', 'locale'];

    const zh = {
      nav: '缓存节省',
      title: '提示缓存与成本',
      subtitle: '缩减每个请求都要重发的工具 Schema，并把「上下文重发成本」摊开来看：哪些内容在重复付费、钱花在哪一类消息上。',
      live: '已生效',
      dryRun: '干跑（只统计，不生效）',
      cardSchemaSaved: '每请求省下',
      cardCost: '会话等价成本',
      cardContext: '最近计费输入',
      cardHit: '缓存命中率',
      cardNew: '新增内容',
      cardResults: '工具结果入史',
      cardSteps: '已观测步数',
      costHint: '≈ {n} tokens（命中价 0.1× 折算）',
      contextHint: '上限 {n} tokens',
      hitHint: '{n}% 由缓存命中',
      newHint: '≈ {n} tokens 全价',
      resultsHint: '{n} 条超过预算',
      stepsHint: '平均 {n} tokens/步',
      tokens: '≈ {n} tokens',
      recommend: '可执行的建议',
      history: '当前上下文构成（按字符占比）',
      bucketUser: '用户消息',
      bucketAssistant: '助手输出',
      bucketToolResult: '工具结果',
      bucketToolCall: '工具调用参数',
      bucketReasoning: '推理块',
      bucketOther: '其他',
      resultsTable: '工具结果归因（按 tokens）',
      schemaTable: 'Schema 缩减明细',
      agentsTable: '各会话统计',
      configSection: '当前配置',
      timelineSection: '事件',
      tool: '工具',
      count: '次数',
      resultTokens: '入史 tokens',
      maxTokens: '单条最大',
      duplicates: '重复调用',
      errors: '出错',
      before: '原始',
      after: '精简',
      saved: '省下',
      pct: '降幅',
      agent: '会话',
      steps: '步数',
      cost: '等价成本',
      context: '上下文',
      createdAt: '建立时间',
      empty: '还没有记录：等下一次会话创建后，这里会出现数据。',
      error: '读取统计失败',
      hint: '数据来自宿主插件的只读接口 /api/cache-saver/status；tokens 取自 provider 返回的 usage，「等价成本」= 0.1 × 缓存命中 tokens + 新增内容 tokens。',
      refresh: '刷新',
      loading: '读取中…',
      generatedAt: '统计时间',
      none: '无',
      more: '还有 {n} 项未显示',
      prefix: '目标前缀',
      keepFull: '保持完整',
      maxSchemaChars: 'Schema 上限',
      maxDescriptionChars: '描述上限',
      bigResultTokens: '大结果阈值',
      levelWarn: '注意',
      levelInfo: '提示',
      levelOk: '正常',
    };

    const en = {
      nav: 'Cache saver',
      title: 'Prompt cache & cost',
      subtitle: 'Shrinks the tool schemas every request re-sends, and breaks down what the re-sent context actually costs — which content is paid for twice.',
      live: 'Active',
      dryRun: 'Dry run (measure only)',
      cardSchemaSaved: 'Saved per request',
      cardCost: 'Session equivalent cost',
      cardContext: 'Latest billed input',
      cardHit: 'Cache hit rate',
      cardNew: 'New content',
      cardResults: 'Tool results entering history',
      cardSteps: 'Steps observed',
      costHint: '≈ {n} tokens (0.1× cache-hit price)',
      contextHint: 'peak {n} tokens',
      hitHint: '{n}% served from cache',
      newHint: '≈ {n} tokens at full price',
      resultsHint: '{n} over budget',
      stepsHint: 'avg {n} tokens/step',
      tokens: '≈ {n} tokens',
      recommend: 'Actionable findings',
      history: 'Composition of the durable history (by chars)',
      bucketUser: 'User',
      bucketAssistant: 'Assistant',
      bucketToolResult: 'Tool results',
      bucketToolCall: 'Tool-call args',
      bucketReasoning: 'Reasoning',
      bucketOther: 'Other',
      resultsTable: 'Tool-result attribution (by tokens)',
      schemaTable: 'Schema reduction detail',
      agentsTable: 'Per-agent stats',
      configSection: 'Configuration',
      timelineSection: 'Events',
      tool: 'Tool',
      count: 'Calls',
      resultTokens: 'History tokens',
      maxTokens: 'Largest',
      duplicates: 'Repeats',
      errors: 'Errors',
      before: 'Before',
      after: 'After',
      saved: 'Saved',
      pct: 'Drop',
      agent: 'Agent',
      steps: 'Steps',
      cost: 'Equiv. cost',
      context: 'Context',
      createdAt: 'Created',
      empty: 'No records yet — data appears once a session has been created.',
      error: 'Could not read the report',
      hint: 'Reads the host plugin’s read-only endpoint /api/cache-saver/status. Equivalent cost = 0.1 × context tokens + new tokens.',
      refresh: 'Refresh',
      loading: 'Loading…',
      generatedAt: 'Generated',
      none: 'none',
      more: '{n} more not shown',
      prefix: 'Target prefixes',
      keepFull: 'Kept full',
      maxSchemaChars: 'Schema cap',
      maxDescriptionChars: 'Description cap',
      bigResultTokens: 'Large-result threshold',
      levelWarn: 'warn',
      levelInfo: 'info',
      levelOk: 'ok',
    };

    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString() : '—');
    const percent = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '—');

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '4px 2px 24px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.55,
      },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      card: {
        flex: '1 1 150px',
        minWidth: '140px',
        boxSizing: 'border-box',
        padding: '12px 14px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      cardValue: { fontSize: '20px', fontWeight: 600, letterSpacing: '-0.01em' },
      cardHint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      section: { display: 'flex', flexDirection: 'column', gap: '8px' },
      sectionTitle: { fontWeight: 600, fontSize: '13px' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap',
      },
      thRight: { textAlign: 'right' },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
      tdRight: { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
      positive: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      chip: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        marginRight: '6px',
        marginBottom: '4px',
      },
      button: {
        alignSelf: 'flex-start',
        padding: '5px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: '12px',
      },
      error: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: '8px',
        padding: '10px 12px',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      bar: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
      barFill: { height: '100%', background: 'var(--dsw-alias-brand-primary)' },
      bucketRow: { display: 'grid', gridTemplateColumns: '110px 1fr 90px', alignItems: 'center', gap: '10px' },
      finding: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    };

    const format = (tpl, values) => String(tpl).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));

    function StatCard(props) {
      return h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardLabel }, props.label),
        h('div', { style: styles.cardValue }, props.value),
        props.hint ? h('div', { style: styles.cardHint }, props.hint) : null,
      );
    }

    function Table(props) {
      const columns = props.columns;
      return h(
        'table',
        { style: styles.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            columns.map((column) => h('th', { key: column.key, style: { ...styles.th, ...(column.right ? styles.thRight : null) } }, column.label)),
          ),
        ),
        h(
          'tbody',
          null,
          props.rows.map((row, index) =>
            h(
              'tr',
              { key: row.key ?? index },
              columns.map((column) =>
                h('td', { key: column.key, style: { ...styles.td, ...(column.right ? styles.tdRight : null) }, title: row.title ?? undefined }, column.render(row)),
              ),
            ),
          ),
        ),
      );
    }

    function CacheSaverSection(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [state, setState] = react.useState({ status: 'loading', report: null, error: null });
      const [reloadToken, setReloadToken] = react.useState(0);

      react.useEffect(() => {
        let cancelled = false;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        setState((previous) => ({ ...previous, status: previous.report ? 'refreshing' : 'loading', error: null }));
        fetch('/api/cache-saver/status', {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((report) => {
            if (!cancelled) setState({ status: 'ready', report, error: null });
          })
          .catch((error) => {
            if (cancelled) return;
            setState((previous) => ({ ...previous, status: 'error', error: String(error && error.message ? error.message : error) }));
          });
        return () => {
          cancelled = true;
          if (controller) controller.abort();
        };
      }, [reloadToken]);

      const report = state.report;
      const totals = report && report.totals ? report.totals : null;
      const config = report && report.config ? report.config : null;
      const results = report && report.results ? report.results : null;
      const history = report && report.history ? report.history : null;

      const header = h(
        'div',
        { style: styles.header },
        h('h2', { style: styles.title }, t('title')),
        h('p', { style: styles.subtitle }, t('subtitle')),
      );

      const refreshButton = h(
        'button',
        { type: 'button', style: styles.button, disabled: state.status === 'refreshing', onClick: () => setReloadToken((value) => value + 1) },
        state.status === 'refreshing' ? t('loading') : t('refresh'),
      );

      if (state.status === 'loading') {
        return h('div', { style: styles.page }, header, h('div', { style: styles.muted }, t('loading')));
      }

      if (state.status === 'error' && !report) {
        return h(
          'div',
          { style: styles.page },
          header,
          h('div', { style: styles.error }, `${t('error')}: ${state.error}`),
          h('div', { style: styles.muted }, t('hint')),
          refreshButton,
        );
      }

      if (!totals || !(totals.agents > 0)) {
        return h('div', { style: styles.page }, header, h('div', { style: styles.muted }, t('empty')));
      }

      const savedPct = typeof totals.savedPct === 'number' ? totals.savedPct : 0;
      const contextTokens = totals.contextTokens || 0;
      const agentCount = Math.max(1, totals.agents || 1);
      const avgContextTokens = Math.round(contextTokens / agentCount);
      const avgStepTokens = totals.steps > 0 ? Math.round(contextTokens / totals.steps) : 0;
      const resultCount = results ? results.count || 0 : 0;
      const bigResults = results ? results.big || 0 : 0;

      const toolRows = (report.tools || []).slice(0, 15).map((item) => ({
        key: item.name,
        name: item.name,
        before: item.before,
        after: item.after,
        saved: item.saved,
        savedPct: item.savedPct,
        title: item.name,
      }));

      const resultRows = ((results && results.byTool) || []).slice(0, 15).map((item) => ({
        key: item.name,
        name: item.name,
        count: item.count,
        tokens: item.tokens,
        maxTokens: item.maxTokens,
        duplicates: item.duplicates,
        errors: item.errors,
        title: item.name,
      }));

      const agentRows = (report.agents || []).map((item) => ({
        key: item.agent,
        agent: item.agent,
        tools: item.tools,
        steps: item.steps,
        context: item.contextTokens,
        cost: item.costEquivTokens,
        saved: item.savedChars,
        createdAt: item.createdAt,
      }));

      const buckets = (history && history.buckets) || {};
      const composedPct = Object.keys(buckets).reduce((sum, key) => sum + (buckets[key] || 0), 0);
      const contextForBuckets = totals.maxContextTokens || totals.contextTokens || 0;
      const bucketRows = ['toolResult', 'assistant', 'user', 'toolCall', 'reasoning', 'other'].map((key) => {
        const share = composedPct > 0 ? (buckets[key] || 0) / composedPct : 0;
        return {
          key,
          label: t(`bucket${key.charAt(0).toUpperCase()}${key.slice(1)}`),
          pct: share * 100,
          tokens: Math.round(contextForBuckets * share),
        };
      });

      const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(', ') : t('none'));

      const findings = ((report.recommendations || []).length > 0 ? report.recommendations : [{ level: 'ok', text: t('empty') }]).map((item, index) =>
        h(
          'div',
          { key: index, style: styles.finding },
          h('span', { style: item.level === 'warn' ? styles.warn : item.level === 'ok' ? styles.positive : styles.muted }, `[${t(`level${item.level.charAt(0).toUpperCase()}${item.level.slice(1)}`)}]`),
          h('span', null, item.text),
        ),
      );

      const timelineRows = (report.timeline || [])
        .slice(-8)
        .reverse()
        .map((item, index) => h('div', { key: index, style: styles.muted }, `${String(item.at).slice(11, 19)}  ${item.kind}  ${item.text}`));

      return h(
        'div',
        { style: styles.page },
        header,
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.chip }, report.dryRun ? t('dryRun') : t('live')),
          h('span', { style: styles.chip }, `v${report.version}`),
        ),
        h(
          'div',
          { style: styles.row },
          h(StatCard, {
            label: t('cardSchemaSaved'),
            value: number(totals.savedChars),
            hint: format(t('tokens'), { n: number(totals.savedTokens) }),
          }),
          h(StatCard, {
            label: t('cardCost'),
            value: number(totals.costEquivTokens),
            hint: format(t('tokens'), { n: number(totals.costEquivTokens) }),
          }),
          h(StatCard, {
            label: t('cardContext'),
            value: number(totals.maxContextTokens),
            hint: format(t('contextHint'), { n: number(totals.maxContextTokens) }),
          }),
          h(StatCard, {
            label: t('cardHit'),
            value: percent(totals.hitPct),
            hint: format(t('hitHint'), { n: percent(totals.hitPct) }),
          }),
          h(StatCard, {
            label: t('cardNew'),
            value: number(totals.newContentTokens),
            hint: format(t('newHint'), { n: number(totals.newContentTokens) }),
          }),
          h(StatCard, { label: t('cardResults'), value: number(resultCount), hint: format(t('resultsHint'), { n: number(bigResults) }) }),
          h(StatCard, { label: t('cardSteps'), value: number(totals.steps), hint: format(t('stepsHint'), { n: number(avgStepTokens) }) }),
        ),
        h('div', { style: styles.bar }, h('div', { style: { ...styles.barFill, width: `${Math.max(0, Math.min(100, savedPct))}%` } })),
        h('div', { style: styles.section }, h('div', { style: styles.sectionTitle }, t('recommend')), ...findings),
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('history')),
          ...bucketRows.map((row) =>
            h(
              'div',
              { key: row.key, style: styles.bucketRow },
              h('span', { style: styles.muted }, row.label),
              h('div', { style: styles.bar }, h('div', { style: { ...styles.barFill, width: `${row.pct}%` } })),
              h('span', { style: styles.tdRight }, format(t('tokens'), { n: number(row.tokens) })),
            ),
          ),
        ),
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('resultsTable')),
          h(Table, {
            columns: [
              { key: 'name', label: t('tool'), render: (row) => h('span', { style: styles.mono }, row.name) },
              { key: 'count', label: t('count'), right: true, render: (row) => number(row.count) },
              { key: 'tokens', label: t('resultTokens'), right: true, render: (row) => number(row.tokens) },
              { key: 'maxTokens', label: t('maxTokens'), right: true, render: (row) => number(row.maxTokens) },
              { key: 'duplicates', label: t('duplicates'), right: true, render: (row) => (row.duplicates > 0 ? h('span', { style: styles.warn }, number(row.duplicates)) : number(row.duplicates)) },
              { key: 'errors', label: t('errors'), right: true, render: (row) => number(row.errors) },
            ],
            rows: resultRows,
          }),
        ),
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('schemaTable')),
          h(Table, {
            columns: [
              { key: 'name', label: t('tool'), render: (row) => h('span', { style: styles.mono }, row.name) },
              { key: 'before', label: t('before'), right: true, render: (row) => number(row.before) },
              { key: 'after', label: t('after'), right: true, render: (row) => number(row.after) },
              { key: 'saved', label: t('saved'), right: true, render: (row) => h('span', { style: styles.positive }, number(row.saved)) },
              { key: 'savedPct', label: t('pct'), right: true, render: (row) => percent(row.savedPct) },
            ],
            rows: toolRows,
          }),
          (report.tools || []).length > toolRows.length
            ? h('div', { style: styles.muted }, format(t('more'), { n: (report.tools || []).length - toolRows.length }))
            : null,
        ),
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('agentsTable')),
          h(Table, {
            columns: [
              { key: 'agent', label: t('agent'), render: (row) => h('span', { style: styles.mono }, row.agent) },
              { key: 'tools', label: t('cardSteps'), right: true, render: (row) => number(row.tools) },
              { key: 'steps', label: t('steps'), right: true, render: (row) => number(row.steps) },
              { key: 'context', label: t('context'), right: true, render: (row) => number(row.context) },
              { key: 'cost', label: t('cost'), right: true, render: (row) => number(row.cost) },
              { key: 'createdAt', label: t('createdAt'), render: (row) => h('span', { style: styles.muted }, String(row.createdAt || '—')) },
            ],
            rows: agentRows,
          }),
        ),
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('configSection')),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.chip }, `${t('prefix')}: ${list(config && config.shadowPrefixes)}`),
            h('span', { style: styles.chip }, `${t('maxSchemaChars')}: ${config && typeof config.maxSchemaChars === 'number' ? config.maxSchemaChars : '—'}`),
            h('span', { style: styles.chip }, `${t('maxDescriptionChars')}: ${config && typeof config.maxDescriptionChars === 'number' ? config.maxDescriptionChars : '—'}`),
            h('span', { style: styles.chip }, `${t('bigResultTokens')}: ${config && typeof config.bigResultTokens === 'number' ? config.bigResultTokens : '—'}`),
            h('span', { style: styles.chip }, `${t('keepFull')}: ${(config && config.keepFull && config.keepFull.length) || 0}`),
          ),
        ),
        h('div', { style: styles.section }, h('div', { style: styles.sectionTitle }, t('timelineSection')), ...timelineRows),
        h('div', { style: styles.footer }, refreshButton, h('span', { style: styles.muted }, `${t('generatedAt')}: ${report.generatedAt || '—'}`)),
        h('div', { style: styles.muted }, t('hint')),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cache-saver:dictionaries');
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key;
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'cache-saver',
            order: 45,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
          },
          (ownerProps) => h(CacheSaverSection, { t, close: ownerProps && ownerProps.close }),
        ),
      );
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.CacheSaverSection = CacheSaverSection;
    return module.exports;
  },
  });
} catch (error) {
  // A second execution of this bundle (the boot script plus an on-demand import,
  // or a stale cached copy) throws "duplicate factory registration". The first
  // registration is already the one in use, and letting the error escape aborts
  // the whole web boot, so treat it as an idempotent no-op.
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('duplicate factory registration')) throw error;
}

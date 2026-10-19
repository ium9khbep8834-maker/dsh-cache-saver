# Cache Saver（缓存节省器）

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5)](https://github.com/ium9khbep8834-maker/dsh-cache-saver)
[![no dependencies](https://img.shields.io/badge/runtime%20deps-none-brightgreen)](package.json)

[English](README.md) · **简体中文**

降低庞大工具集带来的 token 开销，让每次请求中稳定不变的部分更多地落在提示缓存里，并且**量化**地告诉你：被重复发送的上下文到底花在了哪里。

## 安装

DeepSeek Harness 的 host + client 双边插件 —— **无需构建、零运行时依赖**。

```bash
git clone https://github.com/ium9khbep8834-maker/dsh-cache-saver
```

然后安装到某个 profile：

- **插件管理器（推荐）**：`install_bundle`，`target` 指向刚克隆的目录（绝对路径）。
- **手工安装**：把目录复制到
  `~/.dsh/profiles/<profile>/node_modules/@local/dsh-cache-saver`，并在该 profile 的
  `cordis.yml` 里加一行：

```yaml
- id: cache-saver
  name: '@local/dsh-cache-saver'
  config: {}   # 可选，见下方「配置」
```

重启应用（或重载该 bundle）一次。client 半边是在页面引导（boot）时导入的，所以设置页入口只有在**重启 / 刷新页面**之后才会出现，之后进入 **设置 → 缓存节省**。

## 要解决的问题

每次请求都会把整个提示前缀重新发一遍：工具 schema、system 段、以及全部消息历史。在这台机器上，光是工具 schema 就是 **275 个工具 / 约 722,000 字符的 `parameters` JSON（≈180K tokens）**，其中 82% 来自同一个 MCP 服务器（`rea`，207 个工具）。有几个工具单条就极其庞大：

| 工具 | schema 字符数 |
|---|---|
| `mcp__rea__compare_web_captures` | ~155,600 |
| `mcp__rea__compare_application_versions` | ~28,900 |
| `mcp__rea__inspect_analysis_view` | ~27,500 |
| `mcp__rea__evaluate_reconstruction_coverage` | ~24,600 |
| `mcp__rea__project_managed_application_graph` | ~21,200 |

两个事实说明这件事值得做：

1. **缓存命中率与「省钱」是反向的。** 命中率接近 100% 说明几乎所有输入 token 都是 *缓存读取* —— 什么都没被移除。想省钱要靠把前缀**变小**，而不是让它命中得更频繁。
2. **任何进入上下文的内容，在之后的每一次请求里都会再次计费** —— 通常按缓存读取价（约输入价的 0.1 倍）而不是全价，但它会随每一步累积。所以「巨大的工具结果」和「冗长的助手输出」与 schema 同样重要。

## 这个插件做了什么

### 1. Schema 瘦身（按 agent 作用域，调度链路不变）

对每个 agent，它注册一份所选工具的**作用域副本**，其 `parameters` 被压紧但仍然可调用：

- 顶层参数的**名字和基础类型保留**，模型仍然知道该传哪个参数；
- 深层嵌套折叠成 `{ "type": "object", "additionalProperties": true }` 加一句简短说明；
- `examples`、`default`、`$comment`、`title`、`$id`、`$schema` 等纯注解关键字被丢弃；
- 散文式描述被截断，`oneOf`/`anyOf` 分支超过 `maxBranches` 会被截断并附明确提示；
- 整个 schema 反复测量、反复折叠，直到落入 `maxSchemaChars`（或该工具被放进 `keepFull`）。

作用域工具会遮蔽（shadow）全局工具 —— 这是 `tools.register` 的文档化行为 —— 而
`execute`、`output`、`presentCall`、`presentResult`、`timeoutMs` 都从原始定义复制而来，因此**调度链路完全不变**。注册归 agent 自己的 context 与插件自己的 `ctx.effect` 所有，agent 结束或插件卸载时会自动消失。

在本机实测：**158 个工具被瘦身，740,692 → 121,190 字符（−83.6%，约 −154,900 tokens/请求）**。本次会话的某一步随后按 `input 133,164 tokens` 计费、缓存命中 `99.5%` —— 活下来的前缀被缓存，钱花在那约 1,400 个变化了的全价 token 上。

### 2. 上下文成本测量（只观测，不改写）

成本取自 provider 自己回报的 `usage` 数字，而不是字符启发式：用「字符数/4」估算本机历史会读出约 3 倍于实际计费的 token（它还会把压缩折叠已经替换掉的内容算进去），那样页面上每张卡都会虚高。

- `tools/result` —— 每个工具结果：内容字符数、近似 token、重复的相同调用、错误、按工具的汇总（**从不记录负载正文**）。
- `session/event` + `assistant/message` —— 每次真实计费的模型调用：
  `usage.inputTokens`、`usage.cacheReadTokens`、`usage.cacheWriteTokens`、
  `usage.outputTokens`，以及持久历史按桶的构成比例（用户 / 助手 / 工具结果 / 工具调用参数 / reasoning / 其它），外加两个派生值：

  - `new_tokens = input_tokens − cache_read_tokens`（按全价支付的量）
  - `cost ≈ 0.1 × cache_read_tokens + new_tokens`（单步按缓存价折算的等价成本）

  页面同时展示计费口径的缓存命中率（`cache_read / input`），让「高命中率」和「小账单」两个目标并排可见。

### 3. 设置页（client 半边）

bundle 自带 `client.js`，向设置面板贡献一页：

- 槽位 `settings.section`，id `cache-saver`，order `45`（位于「插件 / 市场」与「哔哩」之间）。
- 数据来自 `GET /api/cache-saver/status` —— host `webServer` 上的只读路由，同源、无需凭据、`cache-control: no-store`。
- 内容：省下的字符 / ≈tokens、会话等价 token 成本、最近一次计费输入及其缓存命中率、新增（全价）内容、工具结果入史体积与超阈值条数、已观测步数、历史构成条形图、按 token 排序的前 25 个工具结果、前 15 条 schema 缩减、每个 agent 一行、实时配置 chips、事件时间线，以及**可执行的建议**。

建议是算出来的，不是写死的，例如：

- `N 条工具结果超过 bigResultTokens（最大 M）` → 下调
  `spill-policy.maxInlineTokens`，或把嘈杂工作委派给子会话；
- 完全相同的重复调用 → 缓存答案而不是重调；
- 平均每步上下文 → 估算本会话的输入成本；
- 仍有 schema 超过 `maxSchemaChars`。

由于 client 半边从 boot manifest 加载，安装时已经打开的页面看不到它：**刷新一次（F5）**。

不用 GUI 也能检查路由：

```bash
curl -s http://127.0.0.1:52811/api/cache-saver/status
```

## 配置

所有键都可选；写在该行的 `config` 里（`cordis.patch.yml` 或 profile 的 `cordis.yml`）。

| 键 | 默认值 | 含义 |
|---|---|---|
| `shadowPrefixes` | `["mcp__rea__"]` | 只有带这些前缀的工具会被瘦身 |
| `keepFull` | 8 个核心 `mcp__rea__` 读工具 | 永不瘦身的精确工具名 |
| `minChars` | `700` | 已经这么小的 schema 只做描述截断 |
| `maxSchemaChars` | `800` | 瘦身后的目标上限 |
| `maxDepth` | `3` | 保留的最深嵌套；更深的 object 变成 `additionalProperties` |
| `topDescriptionChars` | `140` | schema 根级描述上限 |
| `nestedDescriptionChars` | `60` | 下一层描述上限 |
| `descriptionDepth` | `1` | 更深的描述直接丢弃 |
| `maxDescriptionChars` | `260` | 工具描述的截断长度（`0` 关闭） |
| `maxBranches` | `4` | 每个联合关键字保留的分支数 |
| `bigResultTokens` | `6000` | 超过此值的结果记为「大结果」 |
| `maxStepSamples` | `60` | 每个 agent 保留的步快照数（用于时间线） |
| `dryRun` | `false` | 只测量，不注册 shadow |

示例：

```yaml
- insert:
    - id: cache-saver
      name: '@local/dsh-cache-saver'
      config:
        shadowPrefixes: ['mcp__rea__', 'mcp__some_other_server__']
        keepFull: ['mcp__rea__inspect_web_page', 'mcp__rea__analyze_function']
        maxSchemaChars: 1200
        bigResultTokens: 4000
```

## 验证

- 工具：**`cache_saver_status`** —— 被瘦身的工具、字符前后对比、≈节省 tokens、
  工具结果体积、计费步（输入 / 缓存 / 命中率）、等价成本、建议。
- 页面：设置 → 缓存节省（安装/升级后需刷新一次）。卡片：每请求节省、会话等价成本、最近计费输入、**缓存命中率**、**新增全价内容**、入史结果、步数。
- 路由：`curl -s http://127.0.0.1:52811/api/cache-saver/status`。

## 安全性说明

- 过度瘦身**不会破坏调用**：DSH 不会拿 `parameters` 去校验参数，被 shadow 的定义仍然保留原始 `execute`。唯一风险是模型记不住某个罕见深层选项 —— 调大 `maxSchemaChars` / `maxDepth`，或把该工具加入 `keepFull` 即可。
- 先 `dryRun: true` 观察一遍。
- 观测钩子只读消息内容来数字符；**不存储、不记录任何负载、参数或结果正文** —— 只有尺寸、计数和名字。
- 不向会话日志写入任何内容，也不修改其它插件的全局工具。

## 诚实的局限

- 这个插件**降低每次请求的输入成本**；它不会提高缓存命中率百分比（移除内容本身就会机械地拉低该百分比）。
- 如果 provider 根本没有做提示缓存，省钱效果在金额上更大（被移除的前缀本来要全价计费），但百分比视角就失去意义。
- 剩余空间最大的杠杆是工具结果体积：一条过大的结果一旦进入历史，之后的每次请求都会重发它。页面会把这个体积报出来，好让问题在源头修复（限制结果长度、委派给子会话、或缓存答案）。

## 测试

```bash
node test/unit.mjs    # schema 瘦身、shadow 注册、HTTP 路由、归因、成本
node test/client.mjs  # client bundle：注册形状、页面渲染、错误/空态
```

两套测试都零依赖：它们自己 stub 掉所接触的 Harness 对象，不会启动真实宿主或浏览器。

## 排错

**应用启动失败，报 `web boot: 1 entry did not activate` / `import failed`，渲染进程控制台显示
`client-modules: duplicate factory registration for "<old id>"`。**

`client.js` 里 client 模块的 id 必须等于 `package.json` 里的包名
（`@local/dsh-cache-saver`）。web boot 会按包标识符导入 bundle；id 不一致会注册一个加载器无法解析的工厂，导致 bundle 被执行第二次。0.3.1 已修复：同时给注册过程加了保护，真正的重复执行会变成幂等的空操作，而不是中断启动。

如果残留的旧副本仍然失败：在崩溃对话框里选
`禁用第三方插件、备份 profile patch 并重启`，然后从「插件」设置里重新启用该 bundle（或对 `@local/dsh-cache-saver` 调用 `plugin_manager` 的 `set_bundle`）。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

# Cache Saver（缓存节省器）

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.x-5b6ee1)](#安装)
[![build](https://img.shields.io/badge/build-none-success)](package.json)

[English](README.md) · **简体中文**

DeepSeek Harness 的 host + client 双边插件。每次请求都会把整个提示前缀重发一遍
——包括工具 JSON Schema。这个插件把其中过分臃肿的部分瘦下来（**调度链路不变**），
再在设置页里**把「重发成本花在哪」摊开给你看**。

实测（真实 profile，全新会话的第一次请求）：

| | 工具数 | 提示 tokens |
|---|---|---|
| 关插件 | 269 | **270,767** |
| 开插件 | 270 | **69,559**（−74.3%） |

工具一个没少、调用一个没变，只是说明书变小了。

## 安装

先完全退出 DeepSeek Harness（它占着 `desktop` profile），然后一条命令：

```bat
"<安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:ium9khbep8834-maker/dsh-cache-saver
```

或者用 npm —— 一条命令安装，然后手动把 `"@local/dsh-cache-saver"` 加进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`（npm 不知道 DSH 的
bundle 机制）：

```bash
npm install github:ium9khbep8834-maker/dsh-cache-saver
```

重启应用（或刷新页面）一次 —— client 半边是在页面引导时导入的 —— 之后进入
**设置 → 缓存节省**。其它 profile 用同一命令，把 `--profile desktop` 换成
`web` / `dsh-tui`（用普通 `dsh`，不需要 `.cmd`）。

## 插件做了什么

### 1. Schema 瘦身：工具一个不少，只是说明书变薄

agent 创建时，插件把每个工具定义**复制到该 agent 的作用域**，只替换
`description` / `parameters`；`execute`、`output.render`、超时与安全标记全部继承，
所以调度不变。DeepSeek Harness 本身不校验参数（校验在 MCP 服务端），因此不会出现
"注册被拒"。8 个高频 `rea` 读工具在 `keepFull` 白名单里，原样保留。

默认配置下的典型效果：**158 个工具，740,692 → 121,190 字符（−83.6%）**；五个体积
最大的 schema 被砍掉 91–99%（`compare_web_captures`：155,623 → 1,392）。把
`mcp__github__` 也加进 `shadowPrefixes` 则是 182 个工具、776,706 → 143,679。

### 2. 成本归因：重发的上下文到底花在哪

记录每个工具结果（字符 → tokens、重复调用、出错）以及每个计费步的 `usage`，再换算成
真正有用的口径：

```
提示 = input + cacheRead + cacheWrite
新增内容 = input + cacheWrite            ← 全价付费的部分
等价成本 = 0.1 × cacheRead + 新增内容    ← 可跨请求比较
```

同时按字符占比给当前上下文分类（用户 / 助手 / 工具调用 / 工具结果 / 推理），
所以「历史消息才是大头」是量出来的，不是猜的。

### 3. 设置页

**设置 → 缓存节省** 展示：每请求成本、缓存命中率、新增全价内容、工具结果体积、
Schema 缩减表、各会话统计、建议列表、最近事件时间线。数据来自
`GET /api/cache-saver/status`（同源、只读）。

## 配置

覆盖项写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（能跨启动保留的 patch 层）：

```yaml
- id: cache-saver
  name: '@local/dsh-cache-saver'
  config:
    shadowPrefixes: ['mcp__rea__', 'mcp__github__']
    maxSchemaChars: 800
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `shadowPrefixes` | `['mcp__rea__']` | 要瘦身的工具名前缀 |
| `keepFull` | 8 个核心 `rea` 读工具 | 永不瘦身 |
| `maxSchemaChars` | `800` | 单个 schema 的目标字符数 |
| `maxDescriptionChars` | `260` | 单条描述的目标字符数 |
| `bigResultTokens` | `6000` | 「大结果」阈值 |
| `maxStepSamples` | `60` | 每个 agent 保留的步样本数 |
| `dryRun` | `false` | 只测量、不瘦身 |

细调项：`minChars 700`、`maxDepth 3`、`topDescriptionChars 140`、
`nestedDescriptionChars 60`、`descriptionDepth 1`、`maxBranches 4`。

## 为什么不是「把缓存命中率刷高」？

因为在这里命中率和花钱是**反向**的。99% 命中率意味着几乎所有 token 都是便宜的
cache read，但**分母**取决于你重发了多少东西。删掉 136K 稳定字符会让命中率的天花板
下降，却实打实减少了账单。所以请看**等价 tokens**，别盯比率。

## 安全性与局限

- 调度、参数、结果都不动，只缩小模型看到的那份 schema 副本。
- 极少用的深层参数可能被折叠掉 —— 把该工具加进 `keepFull`，或 `dryRun: true` 整体关闭。
- v0.3.1 仍有一处口径差异：工具结果体积按 `字符 / 4` 估算，而每步成本用 provider 的
  真实 `usage`。

## 开发

```bash
npm test        # 两套自测，不需要启动宿主
npm run check   # 语法检查
```

## 许可

MIT

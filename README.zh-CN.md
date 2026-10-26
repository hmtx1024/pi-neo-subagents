# pi-neo-subagents

[![CI](https://github.com/hmtx1024/pi-neo-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/hmtx1024/pi-neo-subagents/actions/workflows/ci.yml)

[English](README.md) · **简体中文**

为 [Pi](https://github.com/earendil-works/pi) 提供子代理：把专业化的代理写成
Markdown 定义文件，主代理就能把一件自洽的任务委派给它——你也可以自己直接运行。
每次委派都跑在独立的嵌套会话里，有自己的对话历史，所以主上下文始终小而聚焦。

```bash
pi install npm:pi-neo-subagents
```

- **委派**：主代理调用 `task` 工具，支持单个 / 并发（fan-out）/ 链式（chain），
  可设置单次预算，并有运行台账。
- **定义**：Markdown 定义文件，支持工具白名单、模型覆盖、可选开启的受控递归；
  项目级优先，定义随仓库走、可 review、可提交。
- **直接运行**：`/subagents list|run|new|edit|rm|stats`，不经过模型也能自己跑。

## 安装

从 npm 安装：

```bash
pi install npm:pi-neo-subagents          # 用户级
pi install npm:pi-neo-subagents -l       # 项目级（需要授予项目信任）
```

从目录或单个文件安装（TypeScript，无需构建）：

```bash
pi install /path/to/pi-neo-subagents
pi --extension /path/to/pi-neo-subagents/index.ts
```

项目级安装会写进 `.pi/settings.json`，而 Pi 只在授予项目信任之后才会采用它——
所以要么用 `--approve` 启动 Pi，要么在交互中信任该项目，否则这个包看起来像被忽略。
放进 `~/.pi/agent/extensions/` 或 `<project>/.pi/extensions/` 也能被自动发现。

如果要发布到 npm：从 `package.json` 里删掉 `"private": true`，并加上
`pi-package` 关键词；`pi.extensions` 清单已经声明好了。

## 代理定义

定义是带 YAML 风格 frontmatter 的 Markdown 文件，放在两个资源目录之一：

- 项目级：`.pi/agents/*.md`（同名冲突时优先，列表里会标注来源）。
  发现逻辑会从当前工作目录向上找最近的 `.pi/agents`，所以在子目录里启动 Pi
  依然能找到仓库的代理定义。
- 用户级：`~/.pi/agent/agents/*.md`

```markdown
---
description: Reviews code changes
tools: read, grep
model: anthropic/claude-sonnet-4-5
systemPrompt: replace
---

You are a careful code reviewer. Always cite the file you reviewed.
```

| 字段 | 含义 | 默认值 |
|---|---|---|
| `name` | 规范的代理名 | 文件名（不含扩展名） |
| `description` | 一行描述，用于委派时的发现 | 必填 |
| `tools` | 收窄子代理的工具集（省略 = 内置 + 宿主扩展） | 内置 + 宿主扩展 |
| `model` | 运行所用模型（`provider/id` 或裸 id） | 继承宿主会话的模型 |
| `systemPrompt` | `replace` 表示正文就是完整系统提示词 | 追加到 Pi 的默认提示词之后 |
| `maxTurns` | 单次委派的 assistant 轮数上限 | `subagents.defaultMaxTurns`（50） |
| `timeoutMs` | 墙钟时间上限（毫秒） | `subagents.defaultTimeoutMs`（10 分钟） |
| `maxTokens` | 单次委派的总 token 上限 | 不限制 |
| `thinking` | 思考级别（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`） | 继承 |
| `allowSubagents` | `true` 允许该代理再用 `task` 工具继续委派 | `false` |

frontmatter 同时接受 `tools: read, grep` 和 YAML 块列表两种写法：

```markdown
tools:
  - read
  - grep
```

支持带引号的值和行尾 `# 注释`。定义写错会**直接报错**，而不是悄悄改变行为：

- `tools:` 存在但为空 → 报错（以前它表示"全部默认工具"）
- 引号未闭合 → 报错
- `systemPrompt` 取了 `replace` 以外的值 → 报错（不写这个字段仍然表示追加）
- 创建定义时：未注册的工具名、无法解析的模型、非法预算，或试图使用 `task`
  工具（子代理永远不能再委派）→ 报错
- 同一目录下两个定义用了相同的 `name` → 后一个文件被拒绝，并报重名错误

Markdown 正文就是这个代理的专门指令。

## 创建定义

定义文件既可以手写，也可以让模型来写。`create_subagent` 工具接收
`{ name, description, instructions, tools?, model?, scope?, overwrite? }`，
文件格式和存放位置都由它负责：

- **`scope: "project"`（默认）** → `<cwd>/.pi/agents/<name>.md`，定义随仓库走，
  可以被 review 和提交。
- `scope: "user"` → `~/.pi/agent/agents/<name>.md`，仅在你明确要求时使用。
- 已有定义不会被覆盖，除非 `overwrite: true`；会逃出 agents 目录的名字被拒绝；
  生成的文件在落盘前会先做校验。
- 新建的定义在同一个会话里立刻就能被委派。

所以在一个没有任何定义的项目里说"一个子代理审待提交的 diff，一个扫一遍仓库的
TODO"，产出的是项目内的 `reviewer.md` 和 `scout.md`，而不是写进你的全局配置。

## 预算

一次委派可以按轮数、墙钟时间、token 设上限——写在定义里，或者按调用传入
（按调用传入的值优先）：

```jsonc
// task 工具调用
{ "agent": "scout", "task": "…", "maxTurns": 3, "timeoutMs": 60000, "thinking": "low" }
```

每次委派还有一层兜底默认值——定义和调用都没设上限时才生效：
`subagents.defaultMaxTurns`（50）和 `subagents.defaultTimeoutMs`（10 分钟）。
把其中任意一个设为 `0` 即在全局关闭该上限；定义里或按调用显式传入的值永远优先。
这样模型跑飞或命令挂起（宿主 bash 不带显式 timeout 时没有看护）都不会把并发
派发无限期堵死——运行会被腰斩并如实上报，而不是卡住。

触到上限是一类**正常结果，不是失败**：子代理已经产生的内容会原样返回，并附一句
指明是哪个预算被触发的提示，例如
`[Budget stop: turns limit 1 reached (observed 1). Partial reply above.]`。
于是"被腰斩"和"真失败"始终可区分，用量信息也照常汇报花了多少。

## 从主代理委派

`task` 工具的描述里会列出所有可用的代理、两个定义目录，并说明项目级定义优先。
主代理派活时必须写**自洽的**任务描述——子代理只看得到任务文本，永远看不到宿主
对话。子代理的最终回复作为工具结果返回（过长的回复在 30,000 字符处截断，完整
内容写入临时文件）。

子代理的系统提示刻意从简：定义正文 + Pi 核心规则——不带技能、主题、提示词模板，
也不带 Pi 文档指针；需要这些知识就写进任务文本。

### 并发（fan-out）

一次调用可以同时派发多个任务：

```jsonc
{ "tasks": [
  { "agent": "reviewer", "task": "Review the diff of src/ for bugs" },
  { "agent": "scout",    "task": "Find every TODO under src/", "maxTurns": 4 }
] }
```

- 结果按**提交顺序**返回，每个任务一个区块，带状态（`ok`、`budget stop (…)`、
  `failed`）和详情。
- 一个任务失败不会取消其它任务；只有**全部**失败时整个调用才算错误。
- 默认并发上限为 4，可用 `PI_NEO_SUBAGENTS_MAX_CONCURRENCY=<n>` 调整。
- 取消这次调用会取消所有在飞任务。
- 单个 `{ agent, task }` 调用的行为与以前完全一致。
- 在 TUI 中会有一个 widget 列出每个在飞委派当前的轮次和工具，派发结束后清空；
  其它模式不会显示。

### 一次性任务（不写定义）

对于不会复用的工作，条目可以直接带内联指令而不写代理名：

```jsonc
{ "instructions": "You read one file and summarize it in three bullets.",
  "tools": ["read"],
  "task": "Summarize docs/specs/subagents.md" }
```

- 不落盘，`/subagents` 里也看不到；这次运行仍会计入 `/subagents stats`，身份是
  固定标签 `ad-hoc`。
- 内联条目支持与定义相同的 `model`、预算和 `tools` 选项，可用于单个、并发和
  链式派发，但永远不能再派生下级子代理。

### 宿主扩展工具

子代理永远不加载宿主扩展——正是这个隔离保证了 `task` 工具绝不会进入嵌套会话。
但你其他扩展提供的工具（搜索插件、浏览器、MCP 工具）会**默认跨入子代理**：
调用执行的是宿主实现，携带宿主会话自己的上下文（包括它的对话框与权限行为）。

- `tools` 列表严格收窄——只有点名的工具进子代理，既可裁剪也可把关扩展工具。
- 内置工具无需特殊处理，原生可用。
- `task` 和 `create_subagent` 即使点名也绝不跨入。
- 白名单里点了子代理给不了的工具，委派直接失败并点名，绝不静默丢弃。
- `/subagents run` 无法桥接（命令上下文接触不到宿主工具）：需要桥接工具的定义
  在该命令下会以同样信息失败——请改用 `task` 工具委派。

### 受控递归

默认情况下子代理不能再委派。定义可以显式开启：

```markdown
---
description: Plans work and delegates the parts
allowSubagents: true
tools: read, task
---
```

开启后，该代理的嵌套会话里会拿到 `task` 工具，同时有深度上限约束整棵树
（`subagents.maxDepth`，默认 2——顶层委派记为深度 1）。超限时该次调用失败，并
报告上限与实际尝试的深度。每个结果都带 `details.depth`，台账里也会显示每个代理
跑到过的最深层级。

### 链式（chain）

步骤可以按顺序执行，每一步能消费上一步的回复——比如"先审后修"的流水线：

```jsonc
{ "chain": [
  { "agent": "reviewer", "task": "Review src/runner.ts and list the problems" },
  { "agent": "fixer",    "task": "Fix exactly these problems, nothing else: {previous}" }
] }
```

- `{previous}` 会被替换成上一步的回复；在第一步里使用它会在任何任务开跑前被拒绝。
- 链在第一个失败**或被预算腰斩**的步骤处停止；剩余步骤标记为 `skipped`，结果里
  会写明每一步的状态。
- 链是严格串行的，所以并发上限对它不适用。

默认委派只有一层：子代理自身永远拿不到 `task` 工具。嵌套会话也不会加载任何扩展、
技能、提示词模板或主题，所以子代理的提示词只有"它的定义 + 任务"，绝不会包含宿主的
技能索引。

## 直接运行

```
/subagents                                          # 列出全部定义
/subagents <name>                                   # 查看某个定义
/subagents run <name> <task>                        # 跑一次；结果只给你看
/subagents run --to-context <name> <task>           # 同时把结果送进模型上下文
/subagents run "code review" <task>                 # 名字含空格时用引号
/subagents run -- <name> <task>                     # -- 之后的内容原样当作字面量
/subagents new <name> [description] [--force]       # 在解析到的项目目录里搭一个定义骨架
/subagents edit <name>                              # 打开对应文件；非法编辑不会保存
/subagents rm <name> [--yes]                        # 确认后删除（脚本里用 --yes）
/subagents stats                                    # 每个代理的运行数、轮数、token、成本、平均耗时
/subagents stats reset                              # 清空本次会话的台账
```

台账按会话统计，覆盖每一次委派——单个、并发、链式的每一步——成功、失败、预算
中止分别计数：

```
Delegation ledger (this session):
- reviewer: 1 run (1 ok, 0 failed, 0 budget stops) · 3 turns · tokens 647 in / 410 out · $0.000718 · avg 4616ms
- scout: 1 run (1 ok, 0 failed, 0 budget stops) · 2 turns · tokens 421 in / 221 out · $0.000411 · avg 2475ms
Total: 2 runs · $0.001130
```

选项只在名字之前解析，所以任务文本里出现的 `--to-context` 仍属于任务内容。
未知选项会被拒绝并打印用法。

直接运行会报告一行用量摘要（模型、轮数、token、成本）。过长的结果在显示时会
缩短，完整内容写入临时文件，文件名在提示里给出。

### 输出通道

| 模式 | 命令输出去哪 |
|---|---|
| TUI | 通知 |
| RPC | `extension_ui_request` 通知 |
| `--print` | stdout |
| `--mode json` | stderr（stdout 是 JSON 事件流） |

长时间的直接运行会显示一行状态（`<agent> · turn N`），结束时清掉。

## Windows / Git Bash

MSYS 会改写以 `/` 开头的参数，所以在命令行里传斜杠命令（`pi -p "/subagents"`）
到 Pi 那里会变成 `D:/Program Files/Git/subagents`。换个引号方式，或者对这一个
参数关闭改写：

```bash
MSYS2_ARG_CONV_EXCL='/subagents' pi -p "/subagents"
pi -p "//subagents"          # MSYS 会吃掉一个斜杠
```

这不影响在 Pi TUI 里输入命令，也不影响 RPC 客户端、cmd.exe 或 PowerShell。

## 设置

可选设置放在 Pi 设置的 `subagents` 键下（全局 `~/.pi/agent/settings.json` 或项目
`.pi/settings.json`）：

```json
{
  "subagents": {
    "confirmProjectAgents": "ask",
    "allowModelCreatedDefinitions": true,
    "allowUserScopeCreation": false,
    "maxDepth": 2,
    "defaultMaxTurns": 50,
    "defaultTimeoutMs": 600000
  }
}
```

| 设置 | 含义 | 默认值 |
|---|---|---|
| `confirmProjectAgents` | `"ask"`、`"allow"` 或 `"deny"`：项目级代理在会话中首次使用前是否需要确认 | `"ask"` |
| `allowModelCreatedDefinitions` | 是否允许模型用 `create_subagent` 写定义 | `true` |
| `allowUserScopeCreation` | 是否允许把定义写进用户级目录 | `false` |
| `maxDepth` | 委派深度上限 | `2` |
| `defaultMaxTurns` | 定义和调用都没设时的兜底轮数上限（`0` = 不限） | `50` |
| `defaultTimeoutMs` | 定义和调用都没设时的兜底墙钟上限（毫秒，`0` = 不限） | `600000` |

确认结果在会话内按代理记忆，拒绝则不执行任何东西。用户级代理和内联（ad-hoc）
条目从不弹确认。在没有对话框 UI 的会话里，`"ask"` 会直接放行（自动化不会被卡住），
而 `"deny"` 依然拒绝。

## 开发

需要 Node 22.19 或更新版本——这是 Pi 宿主 SDK 声明的下限。

```bash
npm ci          # 按提交的 lockfile 安装
npm test        # vitest，全 hermetic：脚本化假模型，不联网
npm run typecheck
npm run test:live   # live 冒烟套件（真实 provider，真实花费）
```

`npm test` 完全离线，从不需要凭证。live 套件被排除在它之外，只能通过
`npm run test:live` 运行（该脚本用 `PI_NEO_SUBAGENTS_LIVE=1` 开启）：

- 它使用 Pi 已有的凭证，必要时先跑 `pi auth`。
- `PI_NEO_SUBAGENTS_LIVE_MODEL=provider/model` 选择模型（默认
  `deepseek/deepseek-flash`）。
- 模型或 provider 缺失会大声失败并给出指引，而不是跳过——所以跑绿就代表真路径
  确实走通了。
- 一次完整运行约 25 秒、几千 token：在临时项目里创建两个定义、并发派发给它们、
  检查文件与台账，再委派一个 ad-hoc 任务以证明没有生成任何定义文件。

测试通过 Pi SDK 驱动完整的内存内代理会话，用 pi-ai 的 `fauxProvider` 作为脚本化
模型；断言只发生在会话边界（工具结果、可见消息、记录下来的 UI 输出）。

仓库结构：

| 路径 | 内容 |
|---|---|
| `index.ts`、`src/` | 扩展本体——所有会发布到 npm 的内容 |
| `test/` | hermetic 测试套件；`test/live/` 是需显式开启的 live 套件 |
| `docs/specs/` | 行为规格，含现行与已被取代的版本 |
| `docs/history/` | 设计记录：各版本对应的票据，以及真实模型测试报告 |
| `scripts/manual-test/` | RPC 驱动与夹具，用于对真实 `pi` 进程做脚本化端到端运行 |
| `RELEASING.md` | 版本如何切分、验证与发布 |

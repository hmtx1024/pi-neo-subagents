# pi-neo-subagents 实机测试记录

- 日期：2026-10-24
- 方式：真实 `pi` 进程加载扩展，跑真模型（`deepseek/deepseek-flash`、`xiaomi/mimo-v2.6-pro/flash`）
- 驱动：`scripts/manual-test/rpc-drive.mjs`（`pi --mode rpc` 的 JSONL 客户端；命令用 print 模式另测）
- 测试现场：`scripts/manual-test/fixtures/`（12+ 个 fixture 定义，分 `project/`、`broken/`、`中文 目录/` 三套工作目录）

> 归档说明（2026-10-24）：本文档与各轮票据原位于 `.scratch/`，现归档到 `docs/history/` 随仓库发布；
> 夹具与驱动脚本归档到 `scripts/manual-test/`。当时产生的原始日志（`.log`、`big.txt`）未归档——
> 体积大且是一次性输出，本报告已逐条摘录其中结论。文中出现的 `.scratch/manual-test/...` 旧路径，
> 请对应到 `scripts/manual-test/...`。
- 测试当时**未修改任何项目源文件**；仅新增测试夹具与日志。后续按本报告完成的修复见文末「六、修复状态」（票 08）。

---

## 一、验证通过的能力（正向结论）

| 能力 | 结果 | 证据 |
|---|---|---|
| 真机委派（`task` 工具） | ✅ | 主 agent 调 `task`，reviewer 在隔离会话读 `hello.ts` 并回三段审查 |
| 上下文隔离 | ✅ | 宿主告知"秘密码 BANANA-42"，再委派询问 → 子代理回 `NO-SECRET` |
| `model` 覆盖 | ✅ | `project-scout`（`xiaomi/mimo-v2.6-flash`）实跑，`details.model = mimo-v2.6-flash` |
| `details` / `usage` 回传 | ✅ | `tool task END` 带 `details={task,model,turns:3,usage:{...}}` |
| 会话统计计入 | ✅ | 走 `task` 工具后 `get_session_stats` 的 tokens/cost 增长（15064 tokens / 0.00056） |
| 动态新增刷新 | ✅ | 会话中途写 `.pi/agents/spellchecker.md`，下一轮模型列出的 agent 从 2 → 3 |
| 删除刷新 | ✅（请求层） | 单测断言 `toolsAdded` 增量中不再含被删 agent；实机模型偶发复读旧答案（模型惰性，见问题 B9） |
| 用户级 / 项目级覆盖 | ✅ | 先列 `USER LEVEL`，写入同名项目文件后变 `PROJECT LEVEL … [overrides user definition]`，详情页 origin 为 `project, overrides user definition` |
| 30k 截断 + 落盘 | ✅ | 47600 字符结果 → notify 30144 字符（30000 + 截断提示），完整内容写入 `%TEMP%\pi-neo-subagents-result-*.txt`（47599 字符，首行正确） |
| 递归结构性阻断 | ✅ | `tools: read, task` 的子代理实跑后声明"我没有 task 工具"，仅持有 `read` |
| 取消（工具已启动） | ✅ | 工具运行 9s 时 abort → `isError=true`，文本 `Task was cancelled.`，7s 收到 |
| 文件级报错 | ✅ | 缺 `description` → `no-description.md: missing required "description" in frontmatter`，其余 agent 仍可用 |
| 未知模型 | ✅ | `Agent definition "bad-model.md": unknown model "xiaomi/definitely-not-a-model".` |
| 空清单 | ✅ | 空目录 → `/subagents` 提示 "No agent definitions found."，task 描述说明无可用 agent |
| 中文路径 / 中文名 | ✅ | cwd 为 `…/中文 目录`，agent 名 `中文代理` 正常列出 |
| `systemPrompt: replace` | ⚠️ 部分 | body 被放到提示最前，但 pi 仍追加 skills 清单与工具说明（见问题 B8） |
| `pi install` 本地安装 | ✅（需信任） | `pi install ../../ -l` 后加 `--approve`，不传 `-e` 即可用 `/subagents` |
| `/reload` | ✅ | 重载后 `/subagents` 仍正常，无重复注册报错 |

---

## 二、问题清单（按严重度）

### 严重（安全/正确性）

**B1. 取消存在竞态：abort 早于工具启动时，委派仍跑完全程**
- 复现：委派一个耗时任务，在 1500ms（此时宿主仍在流式生成 tool call）发 RPC `abort`。
- 实际：宿主一轮结束，但 `task` 工具随后照常启动，跑满 4 轮 / 43.6 秒，返回 `isError=false` 的成功结果，并在用户已发出下一条消息之后把结果写回对话。
- 对照：9s（工具已进入执行）时 abort → 正确返回 `Task was cancelled.`。
- 影响：用户以为取消了，实际继续消耗 token 且污染后续对话；与票 07 AC1「abort 干净收敛」在真实时序下不完全成立。
- 备注：SDK 侧表现为工具调用已被排定后 abort 不阻断执行；插件侧无法区分"信号未中止"，需与 pi 上游确认契约。

**B2. `--to-context` 解析过于粗暴：会吞掉任务正文里的同名文本，并意外注入上下文**
- 复现：`/subagents run reviewer Please explain what the --to-context flag does in this plugin.`
- 实际：任务被改写成 "Please explain what the flag does…"（开关词被剥除），**并且**结果被注入模型上下文（多出一次 turn）。
- 根因：`handleRun` 对 token 做 `filter(t => t !== "--to-context")`，无 `--` 终止符、无前缀约束。
- 建议：只识别 `run` 之后的第一个 `--flag` 段，支持 `--` 终止；或改用 `run --to-context <name> <task>` 严格位置。

**B3. YAML 列表式 `tools:` 静默降级为"全部默认工具"（安全相关）**
- 复现：
  ```markdown
  ---
  description: x
  tools:
    - read
    - bash
  ---
  ```
- 实际：`Tools: all default`，子代理拿到默认工具集（实测成功执行 `pwd`）。
- 用户意图是"只读白名单"，得到的是相反结果，且无任何告警。
- 相关：frontmatter 是手写 `key: value` 解析（`src/agents.ts` 的 `splitFrontmatter`），不处理引号/注释/多行/列表：
  - `description: "A quoted description"` → 显示时带引号
  - `description: "..." # 注释` → 注释被当成值的一部分
  - 未闭合引号 → 不报错，值原样带引号

### 中等（可用性）

**B4. agent 名含空格：能列出但无法调用**
- `.pi/agents/code review.md` → 列表显示 `code review`；`/subagents run code review hello.ts` 解析为 name=`code` → `No agent definition named "code".`
- 建议：名字出现空白时在列表中显式警告，或对 `run` 支持引号包裹。

**B5. 同名定义不报错且重复罗列，委派静默取第一个**
- 两个文件都写 `name: shadow` → 列表出现两个 `shadow`，`task` 工具描述里也是两条；委派实际用 `dup-a.md`。
- 建议：同作用域内重名视为文件级错误，或按确定规则去重并在列表标注。

**B6. 直跑（`/subagents run`）不汇报用量，且全程无进度**
- `get_session_stats` 在直跑前后完全不变（tokens/cost 均为 0 增量）——子代理开销不可见；同任务走 `task` 工具则计入。
- 命令处理期间没有任何 notify/status 更新，长任务在 UI 上就是"没反应"：实测要求生成 8000 词时，180s 与 600s 两次都等不到 prompt 响应（模型约 16 tok/s，属实慢，但用户侧无从区分"在跑"与"卡死"）。
- 建议：`notify` 里附 usage 摘要；直跑复用 `task` 的 `onProgress`，通过 `ctx.ui.setStatus` 展示轮次。

**B7. 直跑长结果直接刷屏**
- 30k 截断对 notify 同样生效（实测 30,144 字符一条通知）。虽保护了上下文，但一条 3 万字的通知在 TUI 里不可读。
- 建议：直跑时只展示前若干百字符 + 临时文件路径，其余摘要化。

**B8. `systemPrompt: replace` 并未隔离全部提示内容**
- 实测子代理报出的"系统提示"= body + `<skills>` 清单（本机 3 个技能）+ 工具说明。
- 根因：嵌套会话设了 `noExtensions: true`，但 skills 仍从 `~/.agents/skills` 注入；`replace` 只替换默认助手提示与规则段。
- 影响：每个子代理提示多出约 3k 字符无关技能索引；实测 reviewer 主动提起 `code-review` skill。
- 建议：嵌套会话同时 `noSkills`（或提供开关）；文档说明 `replace` 的边界。

### 轻微

**B9. 删除定义后，模型可能复读旧清单**
- 移除 `tempone.md` 后追问，模型答 "Unchanged — same set as before" 并复述旧列表（含已删项）。
- 请求层机制正常（单测锁定），判断为模型未重新读取工具声明的惰性行为；但用户侧观感是"删了还在"。
- 建议：列表/详情页明确标注来源文件与 mtime，便于用户自查。

**B10. 提示语不一致**
- `/subagents` 空清单："No agent definitions found."
- `task` 工具描述："No agent definitions are currently available."
- 工具级未知 agent 报错只给 `No agent definition named "ghost".`，不附候选名单（模型需回看描述才能纠正）。

---

## 三、环境/宿主侧发现（非插件缺陷，但影响使用与验收）

**E1. Git Bash（MSYS）会把以 `/` 开头的参数改写为 Windows 路径**

机制：Git for Windows 的命令行外壳是 MSYS2/Cygwin 运行时，运行在 POSIX 命名空间里（`/` = MSYS 安装根，本机是 `D:\Program Files\Git`）。当它 spawn 一个**原生 Windows 程序**（`node`、`pi.cmd`…）时，MSYS 运行时会做「POSIX 路径 → Windows 路径」翻译：

- 以**单个** `/` 开头、看起来像路径的 token 会被前缀上 MSYS 根并改写
- 以 `//` 开头会被视为 UNC 风格，**抑制改写**并去掉一个斜杠
- 以 `-` 开头（`--to-context`）不是路径形态，不改写
- `/c/Users/...` 这类驱动器映射会被改写成 `C:\Users\...`

实测（`node -e 'console.log(process.argv)'` 直接观察 argv）：

| 你写的 | 原生程序实际收到 |
|---|---|
| `/subagents` | `D:/Program Files/Git/subagents` |
| `'/subagents'`（单引号） | `D:/Program Files/Git/subagents` |
| `"/subagents"`（双引号） | `D:/Program Files/Git/subagents` |
| `'/subagents run reviewer x'` | `D:/Program Files/Git/subagents run reviewer x` |
| `//subagents` | `/subagents` |
| `--to-context` | `--to-context` |
| `/c/Users/<you>` | `C:/Users/<you>` |

所以 `pi -p … "/subagents"` 实际收到的是 `D:/Program Files/Git/subagents`，插件命令从未被触发，模型把它当普通消息处理（实测它会去 `ls` 那个路径）。

**引号无效**：引号只影响 shell 分词，MSYS 的改写发生在 shell 之后、exec 之前的 argv 层面。

规避方式（按推荐度）：

| 方案 | 实测结果 |
|---|---|
| `MSYS2_ARG_CONV_EXCL='/subagents' pi -p … /subagents` | ✅ 只排除该参数，其余路径仍正常转换；`pi` shim 正常（`pi --version` → 1.4.0） |
| `pi -p … //subagents` | ✅ MSYS 去掉一个斜杠，程序收到 `/subagents` |
| 用 cmd.exe / PowerShell | ✅ 无 MSYS 层，不转换 |
| `MSYS2_ARG_CONV_EXCL='*'` | ⚠️ 全部参数停止转换，`/c/...` 之类会失效 |
| `MSYS_NO_PATHCONV=1 pi …` | ❌ 破坏 `pi` 的 `/bin/sh` shim：shim 把 `$basedir`（POSIX 路径）交给原生 `node`，不转换后 Node 按「当前盘根」解析成 `<盘符>:\c\Users\<you>\.pi\agent\bin\pi-launcher.js` → `MODULE_NOT_FOUND`。绕过办法是直接 `node ~/.pi/agent/bin/pi-launcher.js …` |

**E2. `--print` / `--mode json` 下扩展命令会执行，但**没有任何用户可见输出**（更正与补充）**

用写盘探针扩展（`marker-probe.ts` / `pong-probe.ts`）确认：

- 命令**确实被执行**：`probe-events.log` 记录 `command ran args="hello" mode=print hasUI=false`（json 模式同样）
- 但 `ctx.ui.notify` 被丢弃：一条通知也不输出
- `pi.sendUserMessage` 注入的消息**不会被执行**：handler 返回后进程直接退出（`/pong` 探针无任何 stdout）
- 对照：普通提示在 print 模式正常输出（`NORMAL-OK`），`task` 工具在 print 模式也完全正常

后果分级：

| 命令 | 非交互模式后果 |
|---|---|
| `/subagents`（列表/详情） | 静默无输出，看似“没反应” |
| `/subagents run …` | **真实执行子代理并消耗 token，但结果一字不显**（实测 2.97s，stdout 为空），结果也无落盘 |

即票 07 AC3「print/json/rpc 行为对等」**不成立**；RPC 模式正常（`hasUI=true`，notify 以 `extension_ui_request` 下发，已全程实测），只有 print/json 降级。
- 建议：`ctx.hasUI === false` 时把结果直接写 stdout（而不是只依赖 notify），并对 `run` 同时输出结果文件路径；否则在 README 说明「非交互模式请用 task 工具，不要用 /subagents」。

**E3. 项目级安装需要信任授权**
- `pi install ../../ -l` 写入 `.pi/settings.json` 后，不带 `--approve` 启动时扩展不加载（`pi list` 也不显示）；加 `--approve` 后正常。（符合 pi 文档的信任模型，属于操作须知，非缺陷。）

**E4. 发布形态缺口**
- `package.json`：`private: true`、无 `pi` 清单（`pi.extensions`）、无 `pi-package` 关键词。
- 本地/目录安装可用（根 `index.ts` 被当作入口加载，已实测），但无法通过 `pi install npm:pi-neo-subagents` 分发，也不会进入 Pi 包画廊。
- 建议如需发布：去掉 `private`，补 `"pi": { "extensions": ["./index.ts"] }` 与 `"pi-package"` 关键词。

---

## 四、未覆盖

- **TUI 交互渲染**：无法自动化（Windows 无 tmux）。`/subagents` 通知的换行、长文本可读性、`setStatus` 表现均未在真终端确认。
- **超长委派的成本控制**：8000 词级输出在 `mimo-v2.6-pro` 上 >600s 未完成（约 16 tok/s），未做进一步压测；截断路径改用 4.7 万字符回显文件验证。
- **并发委派 / 多会话**：设计为串行、单层，未测并发语义。

---

## 五、复现素材

```
.scratch/manual-test/
├── rpc-drive.mjs        # RPC 驱动（支持 PROMPT / SHELL: / WRITE: / REMOVE: / STATS: 指令）
├── notify-probe.ts      # print 模式 notify 可见性对照扩展
├── .pi/agents/          # 12 个夹具（正常 / 坏定义 / 重名 / 空格名 / YAML 列表 / 中文）
├── 中文 目录/.pi/agents/中文代理.md
├── big.txt              # 47600 字符，用于截断测试
└── *.log                # refresh / cancel / cancel2 / trunc5 / misc / dup / yaml / isolation / cost / install 等原始记录
```

常用命令（Git Bash）：

```bash
cd scripts/manual-test/fixtures/project
node ../../rpc-drive.mjs '["/subagents"]'
RPC_MODEL=deepseek/deepseek-flash node ../../rpc-drive.mjs '["/subagents run reviewer Review hello.ts"]'
RPC_APPROVE=1 RPC_NO_EXT=1 node rpc-drive.mjs '["/subagents"]'   # 验证包安装后的自动加载
```


---

## 六、修复状态（票 08）

修复轮次见 `.scratch/pi-neo-subagents/issues/08-live-test-fixes.md`。测试数 38 → 42，`tsc --noEmit` 干净。

| 编号 | 状态 | 修复方式 / 结论 | 覆盖测试 |
|---|---|---|---|
| B3 frontmatter 静默降级 | ✅ 已修 | 支持 YAML 块列表、引号、行尾注释；`tools:` 空值/引号未闭合/行格式错误 → 文件级报错 | `definition-parsing.test.ts` |
| E2 非交互模式无输出 | ✅ 已修 | print → stdout；json → stderr（保住协议流）；tui/rpc → notify | `output-modes.test.ts` |
| B2 `--to-context` 改写任务 | ✅ 已修 | 选项只在名字前解析，支持 `--` 终止符，未知选项报 usage | `run-parsing.test.ts` |
| B5 同名定义 | ✅ 已修 | 同目录重名时后者报错并指向先前文件，列表只出现一次 | `definition-parsing.test.ts` |
| B6 直跑无用量/无进度 | ✅ 已修 | 结果附 usage 尾行（模型/轮次/出入 token/成本）；`setStatus` 展示 `<agent> · turn N` 并在结束时清除 | `output-modes.test.ts` |
| B7 长结果刷屏 | ✅ 已修 | 展示上限 2000 字符 + 完整结果写入临时文件 | `output-modes.test.ts` |
| B4 空格名不可用 | ✅ 已修 | `/subagents run "code review" <task>` 支持引号名 | `run-parsing.test.ts` |
| B8 skills 泄漏进子代理 | ✅ 已修 | 嵌套会话 `noSkills`/`noPromptTemplates`/`noThemes` 全关 | `skill-isolation.test.ts` |
| B10 措辞与候选名单 | ✅ 已修 | 空清单措辞统一；未知 agent 报错附可用列表 | `errors.test.ts` |
| E4 打包清单 | ✅ 已修 | 补 `pi.extensions`；host 包移入 `peerDependencies: "*"`（否则 pi 告警重复运行时模块） | 实机加载无告警 |
| E1 MSYS 改写 | 📄 文档 | 无代码可修；README 给出 `//subagents` 与 `MSYS2_ARG_CONV_EXCL` | — |
| E3 项目级需信任 | 📄 文档 | README 说明 `--approve` | — |
| B9 陈旧清单 | 📄 记录 | 请求层刷新已由测试锁定，属模型惰性 | `task-tool.test.ts` |
| B1 取消竞态 | ⚠️ 上报上游 | 插件尊重传入信号并正常拆除嵌套会话；abort 在宿主尚未开始工具调用时到达属宿主行为 | — |
| （新观察）RPC `disposition: "handled"` 但 run 已启动 | ✅ 非缺陷 | pi 文档明确：`handled` 只描述本次提交的 prompt，「不含扩展自行启动的工作」。命令本应驱动自己的 LLM 交互 | — |

### 实机复验（修复后）

- `pi -p "/subagents"`：列表与解析错误都出现在 stdout/stderr（此前完全静默）
- `pi -p "/subagents run reviewer …"`：结果 + `[reviewer · deepseek-flash · 2 turns · tokens 2373 (in 848 / out 245) · $0.000556]`
- `pi -p --mode json "/subagents"`：stdout 仅 JSON 记录，列表走 stderr
- `pi install … -l` + `--approve`：无 packagedependency 告警，扩展正常加载

### 追加（票 09）：零定义时的定义创建

实测复现：两处目录都为空时，模型先拿到 `No agent definitions found.` 死胡同，然后**手写**两个定义到 `<agentDir>/agents/`（全局），并靠偷看 `PI_CODING_AGENT_DIR` 才让它们生效。

修复后（`create_subagent` 工具 + 描述引导），同一 prompt 的走向：

- 定义由工具生成，落在**项目** `<cwd>/.pi/agents/{python-dev,go-dev}.md`，全局目录零污染
- 生成文件通过同一套解析器校验（frontmatter 一定合法）
- 模型在答复里主动说明「委派是串行执行的」——描述里的 serial 提示生效

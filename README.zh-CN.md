<p align="center">
  <img src="docs/logo.svg" alt="" width="96">
</p>
<h1 align="center">ReflexRun</h1>
<p align="center"><strong>做过就记住，越用越熟练。</strong></p>
<p align="center">为你正在使用的 Computer Use 智能体增加本地操作记忆。</p>
<p align="center">
  <a href="https://kehuitt.github.io/ReflexRun/docs/playground/?lang=zh"><img src="docs/badges/project-page.svg" alt="项目主页" height="30"></a>
  <a href="#快速上手"><img src="docs/badges/quickstart.svg" alt="快速上手" height="30"></a>
  <a href="#真实运行对比"><img src="docs/badges/benchmarks.svg" alt="实测结果" height="30"></a>
  <a href="LICENSE"><img src="docs/badges/mit.svg" alt="MIT 许可证" height="30"></a>
</p>
<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

ReflexRun 从智能体完成并核验的任务中学习。换一批输入，它可以在本地复用已有流程，也能把验证过的步骤组合起来完成新任务。界面变化时，智能体可以修复受影响的步骤，供后续任务复用。

<a name="快速上手"></a>

## 🚀 快速上手

下方以 Codex Desktop 为例。其他智能体可以[通过 MCP 或 SDK 接入](#接入已有智能体)。

**1. 检查工具。** macOS 和 Linux 打开终端，Windows 可用 Git Bash。需要 Node.js 20+、npm，以及已登录且支持 Computer Use 的 Codex Desktop。打算用 Git 克隆时，先检查 Git。

```sh
git --version
node --version
npm --version
```

**2. 获取源码。** 克隆 ReflexRun 并进入项目目录。

```sh
git clone https://github.com/kehuitt/ReflexRun.git
cd ReflexRun
```

已有 `reflexrun.zip` 时，在 ZIP 所在目录运行下面两行。也可以用文件管理器解压，再打开解压出来的 `reflexrun` 文件夹的终端。

```sh
unzip reflexrun.zip
cd reflexrun
```

**3. 安装并检查。** 在项目目录运行下方命令，确认输出包含 `ready: true`。

```sh
npm run setup:codex && node dist/src/cli.js doctor
```

**安装成功后，打开新聊天，直接说任务。** 支持自动匹配 Skill 的宿主可以根据任务描述加载 ReflexRun。想明确指定时，可在支持 `$` 调用的宿主里输入「`$reflexrun` 把这三封邮件归档」。

<details>
<summary>可选 · 在 AGENTS.md 里设置优先使用</summary>

如果你的宿主会读取 `AGENTS.md`，可以手动加入下方这句。安装器不会修改 `AGENTS.md`。

```text
遇到 Computer Use 任务时，如果 ReflexRun Skill 可用，先加载它并检查有无可复用的经验。遵守宿主的授权和核验要求。
```

</details>

**4. 学一次，再换内容试一次。** 在项目目录启动本地 Demo，保持终端运行。

```sh
npm run demo
```

在浏览器中[打开练习收件箱](http://127.0.0.1:4317/docs/playground/?portal=mail&run=quickstart&lang=zh)。里面是虚构邮件。在这个项目里打开支持 Computer Use 的新聊天，直接说：

```text
把练习收件箱里的 MAIL-5101 移到「归档」。
```

第一个任务完成后，打开新聊天并发出下一条任务：

```text
把 MAIL-5102 和 MAIL-5103 移到「归档」。
```

Skill 默认把核验成功的流程保存在 `~/.reflexrun/memory/`。同一个本地用户账号下，换项目或开新聊天都能复用匹配的经验。CLI 使用同一默认目录，也支持用 `--memory PATH` 指定独立目录。

下次收到任务时，ReflexRun 会查找当前网站或应用的经验，再核对任务类型和当前界面是否匹配。命中后就用这次请求里的参数执行。没有合适的经验时，智能体会自行探索并在核验后保存。

**升级并导入已有经验。** 在 ReflexRun 源码目录更新已安装的 Skill，再导入旧经验。导入会保留原件。导入其他项目的经验时，将其经验目录的绝对路径传给 `--memory`。

```sh
npm run setup:codex -- --upgrade
node dist/src/cli.js memories import --memory .reflexrun/memory
```

<details>
<summary>安装到独立目录</summary>

```sh
unzip -q reflexrun.zip
cd reflexrun
node --version
npm run setup:codex -- --skill-directory ../codex-skill
node dist/src/cli.js doctor --skill-directory ../codex-skill
```

`ready: true` 表示安装的运行时检查通过，首次任务验证真实 Computer Use 连接。默认 skill 目录为 `~/.agents/skills/reflexrun`，安装后需打开新聊天。在安装和 doctor 命令中都传入 `--skill-directory PATH` 可测试隔离安装。`--upgrade` 可以更新未经手动修改的安装。卸载 skill 无需删除任务经验。

</details>

<a name="真实运行对比"></a>

## 📊 真实运行对比

两种方式都在 [Mailpit](https://github.com/axllent/mailpit) 中将指定邮件标为已读并添加标签，各通过 28 项核验。[逐轮数据](benchmarks/showcase.json)。

| 阶段             |         原智能体 |  加上 ReflexRun |
| :--------------- | ---------------: | --------------: |
| 首次任务         |  18.05 秒 / 9 次 | 13.71 秒 / 7 次 |
| 换三封新邮件复用 | 24.75 秒 / 13 次 |  1.52 秒 / 0 次 |
| 界面变化后三封   | 25.70 秒 / 13 次 |  7.34 秒 / 1 次 |
| 整批七封邮件     | 70.00 秒 / 35 次 | 24.62 秒 / 8 次 |

ReflexRun 从首封邮件学习，直接复用到后三封新邮件。控件改名后，模型修复一次，剩余邮件继续复用。

<details>
<summary>复现批量实验</summary>

四轮配对实验使用相同输入和工具。耗时取中位数，模型调用次数取最高值。

将官方可执行文件命名为 `mailpit`，放到与源码目录同级的位置。通过 Codex CLI 登录后，从源码目录运行以下命令。[Mailpit v1.33.1](https://github.com/axllent/mailpit/releases/tag/v1.33.1)

```sh
npx playwright install chromium
CODEX_ROLLOUT_TRACE_ROOT="$(mktemp -d)" npx tsx scripts/benchmark-mailpit.ts --binary ../mailpit --out "$(mktemp -d)/mailpit-run" --rounds 4 --settle-ms 0
```

框架启动隔离的本地实例，通过 SMTP 注入合成邮件，保留原始 WebM 录屏、读回核验结果与经验。加上 `--upstream ../mailpit-source` 可检查同级的 Mailpit 源码。原始模型轨迹应留在本地，公开证据只包含汇总计数和脱敏实验数据。

</details>

### 经验跨任务复用

**双方都首次做 C。** 两边此前都完成了 A（找邮件并标已读）和 B（找邮件并加标签）。C 要对一封新邮件同时做这两件事。原智能体由模型驱动操作，ReflexRun 组合 A、B 当轮保存的步骤，四轮都在本地完成 C。单看 C，耗时 **27.12 秒 → 0.61 秒**，模型调用 **16 → 0 次**。[配对实测证据](benchmarks/capabilities.json)。

ReflexRun 可以跳过已满足目标的步骤。多个工作流共用同一个控件时，也可以复用经过核验的修复。

<details>
<summary>复现跨任务组合与共享修复</summary>

将官方可执行文件命名为 `mailpit`，放到与源码目录同级的位置。完成安装并通过 Codex CLI 登录后，从源码目录运行以下命令。[Mailpit v1.33.1](https://github.com/axllent/mailpit/releases/tag/v1.33.1)

```sh
npx playwright install chromium
CODEX_ROLLOUT_TRACE_ROOT="$(mktemp -d)" npx tsx scripts/benchmark-capabilities.ts --paired --auto --binary ../mailpit --out ../mailpit-auto-pairs --rounds 4 --settle-ms 0
npx tsx scripts/benchmark-capabilities.ts --binary ../mailpit --out ../mailpit-repair --rounds 3
```

配对实验逐项核对邮箱状态、原始邮件哈希与返回收件箱。共享修复实验另外覆盖四种初始状态，并改名源轨迹实际用过的控件。每轮保留原始 WebM 和失败记录。

两边完成 A、B 时使用相同的模型、指令和浏览器工具。ReflexRun 根据已核验的结果在本地提炼，相同的步骤只存一份。首次做 C 时，ReflexRun 根据结构化目标与可信读取器在本地尝试组合。

</details>

<a name="接入已有智能体"></a>

## 🧩 接入已有智能体

| 入口               | 用途                                   |
| :----------------- | :------------------------------------- |
| `reflexrun/memory` | 学习、复用、批量、修复与宿主适配       |
| `reflexrun/proxy`  | 接入现有 Playwright MCP 工具端口       |
| `reflexrun`        | 同一核心 API，另提供策略与模型辅助工具 |

核心通过宿主提供的接口观察和操作界面。Codex Desktop 有专门的安装入口，也是公开实测所用的智能体。Playwright MCP 代理可由支持本地 stdio 的 MCP 客户端使用，已用官方 Playwright MCP 服务验证。接入其他智能体的内置 Computer Use 工具，需要对应的宿主适配器。自定义宿主可实现 [`Host`](src/memory/types.ts)，或使用 [`CallbackHost`](src/memory/callback.ts)。

<details>
<summary>接入其他 MCP 客户端</summary>

在源码目录运行：

```sh
npm ci --include=dev
npm run build
node node_modules/@playwright/mcp/cli.js install-browser chrome-for-testing
```

将下方命令注册为本地 stdio 服务。它会为客户端启动一个隔离的 Playwright 浏览器会话。

```sh
node "$PWD/dist/src/cli.js" proxy -- node "$PWD/node_modules/@playwright/mcp/cli.js" --browser chromium --headless --isolated
```

Claude Code 用户可在命令前加上 `claude mcp add --transport stdio reflexrun --`。让智能体用代理提供的浏览器工具打开起始页，调用 `reflex_begin`，首次探索并核对完成后调用 `reflex_finish`。客户端审批规则继续生效。目前发布的模型实测使用 Codex。[Claude Code MCP 安装说明](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server)

</details>

核验成功的流程通过引用共享操作步骤。自动跨任务组合使用 SDK。对于页面路径可核实的浏览器任务，宿主提供可信事实读取器和结构化目标时，`CapabilityCapture` 会在完成后自动提炼可复用片段。让 `CapabilityLibrary` 与 `ExperienceStore` 使用同一目录，即可共享已保存的步骤。`CapabilityLibrary.run()` 优先按目标和当前状态在本地组合唯一且相容的计划。匹配不确定时可由宿主提供 `selectPlan`。页面路径和控件无法证明当前记录身份时，宿主需在 `beforeEffect` 中核对。

<details>
<summary>MCP、SDK 与核对选项</summary>

编译后连接共享会话的 Playwright MCP：

```sh
node dist/src/cli.js proxy --upstream http://127.0.0.1:8931/mcp
```

上游需共享浏览器 context，或通过 CDP 连接原浏览器。代理保留原工具，增加 `reflex_begin`、`reflex_finish` 与局部补丁入口。核对成功后，`finish()` 可以先返回 `learning: 'pending'`，流程整理与存盘继续执行，不在后台操作界面。SDK 调用方可用 `await proxy.waitForLearning()` 获取最终 `ready` 或 `failed` 学习结果；下次 `begin()` 自动等待，学习失败会明确报告。`await Reflex.run()` 继续等待经验完整保存。客户端审批规则继续生效。不支持的调用可透传，但不会生成不完整经验。这是工具代理，不镜像全部 MCP resource 或 prompt。

Codex 修复接入可用 `CodexToolAgent.runUntilTool(..., 'submit_patch')` 在有效提案返回后继续，省去等待收尾文字。它报告 `bounded-result`，不冒充模型回合完成；调用方先验证提案，再由正常执行与读回判断修复是否成功。其他宿主继续使用各自的原智能体回调。

具备独立结果核对时，可用 `--timeout-settle 0` 启动 Playwright MCP，也可在 API 中设置 `timeouts: { settle: 0 }`。代理从实时页面定位下一个控件，相邻步骤可以共用一次观察。刚切换页面时，代理最多给编辑控件留 250 毫秒初始化时间，随后重新定位再执行。上游设置由宿主控制。[上游配置说明](https://github.com/microsoft/playwright-mcp#configuration)。

如需 ReflexRun 单独管理浏览器：

```sh
npx playwright install chromium
node dist/src/cli.js mcp
```

使用 `reflex_task` → `reflex_act` → `reflex_complete`；已学批次使用 `reflex_batch` 与 `reflex_repair`。SDK 宿主实现 [`Host`](src/memory/types.ts)，通过 [`Reflex`、`AgentBridge`、`BatchBridge` 与 `TaskCapture`](src/memory/index.ts) 接入原智能体和工具。`TaskCapture` 处理逐次 RPC 动作，`BatchBridge` 负责批量修复和最终晋升。

`attempt` 记录尝试，`batch` 批末核对，`readback` 逐项独立读回，`task` 检查 UI 完成条件。未知写入先核对再重试。固定偏好按版本编译，变化的价格、资格和条目身份需要现场事实。宿主负责条目发现、授权和读取器。自定义宿主的自动保存输入等隐式写入需在动作中显式设置 `effect: true`，才能纳入策略与写入意图保护。纯截图目标、任意原生控件需进一步适配验收；当前桌面浏览器实测覆盖 macOS。

</details>

<a name="一起开发"></a>

## 🛠️ 一起开发

```sh
npm ci --include=dev
npm run check
npm run test:core
```

从源码目录运行这些检查，无需浏览器或模型密钥。浏览器回归需先安装 Chromium，再运行 `npm test`。改动聚焦单一目标，行为变化补回归测试。`src/memory` 负责学习/回放，`src/proxy` 负责工具代理，`test` 放夹具，`scripts` 放安装和基准入口。修改分发时，先运行 `npm run release:desktop`，再运行 `npm run verify:distribution`。

[MIT 许可证](LICENSE) · [Skill](skills/reflexrun/SKILL.md) · [SDK](src/memory/index.ts) · [实测证据](benchmarks/showcase.json)

<a name="致谢"></a>

## 🙏 致谢

感谢这些项目的作者和维护者所做的贡献。[Agent Workflow Memory](https://github.com/zorazrw/agent-workflow-memory) · [SkillWeaver](https://github.com/OSU-NLP-Group/SkillWeaver) · [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) · [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Mailpit](https://github.com/axllent/mailpit) · [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)

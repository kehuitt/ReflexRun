<p align="center">
  <img src="docs/logo.svg" alt="" width="96">
</p>
<h1 align="center">ReflexRun</h1>
<p align="center"><strong>Learn by doing. Get better over time.</strong></p>
<p align="center">Local procedural memory for the Computer Use agent you already use.</p>
<p align="center">
  <a href="https://kehuitt.github.io/ReflexRun/"><img src="docs/badges/project-page.svg" alt="Project Page" height="30"></a>
  <a href="#get-started"><img src="docs/badges/quickstart.svg" alt="Quickstart" height="30"></a>
  <a href="#the-real-run"><img src="docs/badges/benchmarks.svg" alt="Benchmarks" height="30"></a>
  <a href="LICENSE"><img src="docs/badges/mit.svg" alt="MIT License" height="30"></a>
</p>
<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">Chinese</a>
</p>

ReflexRun learns from tasks your agent completes and verifies. It replays familiar workflows locally with new inputs and combines verified steps for new tasks. When an interface changes, your agent can repair the affected step for reuse.

<a name="get-started"></a>

## 🚀 Quick Start

The steps below use Codex Desktop. You can also connect [another agent through MCP or the SDK](#fits-around-your-agent).

**1. Check your tools.** Open Terminal on macOS or Linux, or Git Bash on Windows. Use Node.js 20+ with npm and a signed-in Codex Desktop with Computer Use. Check Git if you plan to clone the repository.

```sh
git --version
node --version
npm --version
```

**2. Get the source.** Clone the repository and enter its directory.

```sh
git clone https://github.com/kehuitt/ReflexRun.git
cd ReflexRun
```

If you have `reflexrun.zip`, run these two lines from the folder containing it instead. You can also extract it in your file manager and open a terminal inside the extracted `reflexrun` folder.

```sh
unzip reflexrun.zip
cd reflexrun
```

**3. Install and check.** Run this from the project folder and look for `ready: true`.

```sh
npm run setup:codex && node dist/src/cli.js doctor
```

**Open a new chat and describe the task.** Hosts that support automatic skill selection can load ReflexRun from your request. To select it explicitly in a host that supports `$` mentions, try “`$reflexrun` archive these three emails.”

<details>
<summary>Optional · Prefer ReflexRun in AGENTS.md</summary>

If your host reads `AGENTS.md`, you can add this line yourself. The installer leaves `AGENTS.md` untouched.

```text
For Computer Use tasks, load the ReflexRun Skill when available and check for a matching experience before acting. Follow the host’s approval and verification requirements.
```

</details>

**4. Learn one task and reuse it.** From the project folder, start the local demo and leave its terminal running.

```sh
npm run demo
```

[Open the practice inbox](http://127.0.0.1:4317/docs/playground/?portal=mail&run=quickstart) in your browser. It contains fictional messages. In a new chat in this project with Computer Use available, ask:

```text
Move MAIL-5101 to Archive in the practice inbox.
```

After the first task finishes, open a new chat and ask for the next batch:

```text
Move MAIL-5102 and MAIL-5103 to Archive.
```

The Skill saves verified workflows to `~/.reflexrun/memory/` by default. New chats and projects under the same local user account can reuse matching workflows. The CLI uses the same default and accepts `--memory PATH` for a separate store.

On the next request, ReflexRun looks up the current site or app, checks which workflow fits the operation and the current screen, and uses the new inputs. If no workflow fits, the agent explores and saves the result after verification.

**Upgrade and import earlier workflows.** In the ReflexRun source directory, update the installed Skill, then import the old store. The import keeps the original files. For a store in another project, pass its absolute path to `--memory`.

```sh
npm run setup:codex -- --upgrade
node dist/src/cli.js memories import --memory .reflexrun/memory
```

<details>
<summary>Install into a separate directory</summary>

```sh
unzip -q reflexrun.zip
cd reflexrun
node --version
npm run setup:codex -- --skill-directory ../codex-skill
node dist/src/cli.js doctor --skill-directory ../codex-skill
```

`ready: true` checks the installed runtime. Your first task validates the actual Computer Use connection. The default skill location is `~/.agents/skills/reflexrun`; open a new chat after installation. Pass `--skill-directory PATH` to both setup and doctor to test in a separate directory. `--upgrade` updates an unmodified installation. Removing the skill does not require deleting task memories.

</details>

<a name="the-real-run"></a>

## 📊 The real run

In [Mailpit](https://github.com/axllent/mailpit), both agents marked the requested emails as read and applied their tags. Both passed all 28 checks. [Run data](benchmarks/showcase.json).

| Stage                             |     Original agent |    With ReflexRun |
| :-------------------------------- | -----------------: | ----------------: |
| First email                       |  18.05 s / 9 calls | 13.71 s / 7 calls |
| Three new emails                  | 24.75 s / 13 calls |  1.52 s / 0 calls |
| Three emails after a label change | 25.70 s / 13 calls |   7.34 s / 1 call |
| Whole seven-email job             | 70.00 s / 35 calls | 24.62 s / 8 calls |

ReflexRun learns from the first email and replays the next three locally. When the control changes, it asks the model for a repair and reuses it for the rest of the batch.

<details>
<summary>Reproduce the batch benchmark</summary>

Four paired runs use the same inputs and tools. Times are medians and model calls are the highest observed counts.

To reproduce, name the official Mailpit executable `mailpit` and place it beside the checkout. Sign in with the Codex CLI and run these commands from the source directory. [Mailpit v1.33.1](https://github.com/axllent/mailpit/releases/tag/v1.33.1)

```sh
npx playwright install chromium
CODEX_ROLLOUT_TRACE_ROOT="$(mktemp -d)" npx tsx scripts/benchmark-mailpit.ts --binary ../mailpit --out "$(mktemp -d)/mailpit-run" --rounds 4 --settle-ms 0
```

The harness starts isolated local instances, seeds synthetic SMTP messages, and closes them afterward. It retains native WebM recordings, readbacks and learned workflows. Add `--upstream ../mailpit-source` to check an adjacent Mailpit source checkout. Keep raw model traces private. The published evidence contains only aggregate counts and sanitized benchmark data.

</details>

### Reuse experience across tasks

**First attempt at C.** Both agents previously marked an email read (A) and tagged an email (B). For C, they had to do both on a new email. The original agent used the model to work through C. ReflexRun combined the steps saved during A and B and completed C locally in all four pairs. C alone took **27.12 s → 0.61 s** and **16 → 0 model calls**. [Paired measurements](benchmarks/capabilities.json).

ReflexRun can skip steps whose outcomes already hold and reuse a verified repair across workflows that share a control.

<details>
<summary>Reproduce composition and shared repair</summary>

Place the official executable named `mailpit` beside the checkout. After setup, sign in with the Codex CLI and run these commands from the source directory. [Mailpit v1.33.1](https://github.com/axllent/mailpit/releases/tag/v1.33.1)

```sh
npx playwright install chromium
CODEX_ROLLOUT_TRACE_ROOT="$(mktemp -d)" npx tsx scripts/benchmark-capabilities.ts --paired --auto --binary ../mailpit --out ../mailpit-auto-pairs --rounds 4 --settle-ms 0
npx tsx scripts/benchmark-capabilities.ts --binary ../mailpit --out ../mailpit-repair --rounds 3
```

The paired benchmark verifies exact mailbox state, raw message hashes and inbox return after every task. The shared repair experiment also tests four starting states and renames a control learned from the source runs. Each round preserves the original WebM and any failures.

Both arms use the same model, A and B instructions, and browser tools. ReflexRun derives reusable steps locally from verified outcomes and stores identical steps once. The ReflexRun arm attempts its first C through local composition with a typed goal and a trusted fact reader.

</details>

<a name="fits-around-your-agent"></a>

## 🧩 Fits around your agent

| Entry              | Use it for                                          |
| :----------------- | :-------------------------------------------------- |
| `reflexrun/memory` | Learning, replay, batches, repair and host adapters |
| `reflexrun/proxy`  | An existing Playwright MCP tool port                |
| `reflexrun`        | The same core API, plus policy and model helpers    |

The core uses the host's observation and action tools. Codex Desktop has a dedicated setup command and is the agent used in the published benchmarks. The Playwright MCP proxy works with a local stdio MCP client and has been tested with the official Playwright MCP server. A different agent's built-in Computer Use tools need a compatible host adapter. Custom hosts can implement [`Host`](src/memory/types.ts) or use [`CallbackHost`](src/memory/callback.ts).

<details>
<summary>Connect another MCP client</summary>

From a source checkout:

```sh
npm ci --include=dev
npm run build
node node_modules/@playwright/mcp/cli.js install-browser chrome-for-testing
```

Register this command as a local stdio server. It starts an isolated Playwright browser session for the client.

```sh
node "$PWD/dist/src/cli.js" proxy -- node "$PWD/node_modules/@playwright/mcp/cli.js" --browser chromium --headless --isolated
```

In Claude Code, prepend `claude mcp add --transport stdio reflexrun --` to the command. Ask your agent to open the starting page with the proxy's browser tools, call `reflex_begin`, then call `reflex_finish` after it verifies a newly explored task. Client approval rules still apply. The published model runs used Codex. [Claude Code MCP setup](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).

</details>

Verified workflows reference shared action steps. Automatic cross-task composition uses the SDK. On a browser task with verifiable routes, a trusted fact reader and a typed goal, `CapabilityCapture` derives reusable ranges locally on completion. Give `CapabilityLibrary` the same directory as `ExperienceStore` to share stored steps. `CapabilityLibrary.run()` first tries to assemble a unique compatible plan for the current state and goal. The host can provide `selectPlan` for uncertain matches. When the UI cannot establish the active record through its route or locator, bind it in `beforeEffect`.

<details>
<summary>MCP, SDK and verification options</summary>

After building, connect a shared Playwright MCP session:

```sh
node dist/src/cli.js proxy --upstream http://127.0.0.1:8931/mcp
```

The upstream must share the browser context or attach to the existing browser through CDP. The proxy retains native tools and adds `reflex_begin`, `reflex_finish` and bounded patching. After successful verification, `finish()` can return with `learning: 'pending'` while workflow compilation and persistence continue without UI actions. SDK callers use `await proxy.waitForLearning()` to receive the final `ready` or `failed` learning result; the next `begin()` waits automatically and reports a learning failure. `await Reflex.run()` retains its fully persisted result semantics. Client approval rules still apply. Unsupported calls pass through but do not create an incomplete learned workflow. This is a tools proxy; it does not mirror every MCP resource or prompt.

The Codex repair provider can use `CodexToolAgent.runUntilTool(..., 'submit_patch')` to return a validated proposal without waiting for closing prose. It reports `bounded-result`, not a completed model turn. The caller validates the proposal; the normal execution and readback still decide whether the repair worked. Other hosts keep their own agent callbacks.

With an independent result check, start Playwright MCP with `--timeout-settle 0`, or set `timeouts: { settle: 0 }` in its API configuration. The proxy resolves the next control from the live page and shares that observation between adjacent steps. For editable controls on a newly observed route, it allows up to 250 ms for initialization and resolves the control again before dispatch. The upstream host owns its configuration. [Upstream configuration](https://github.com/microsoft/playwright-mcp#configuration).

For a separate browser managed by ReflexRun:

```sh
npx playwright install chromium
node dist/src/cli.js mcp
```

Use `reflex_task` → `reflex_act` → `reflex_complete`; learned batches use `reflex_batch` and `reflex_repair`. SDK hosts implement [`Host`](src/memory/types.ts). [`Reflex`, `AgentBridge`, `BatchBridge` and `TaskCapture`](src/memory/index.ts) attach to the original agent and tools. `TaskCapture` handles individual RPC actions; `BatchBridge` owns batch repair and final promotion.

Choose `attempt` for dispatch records, `batch` for a final audit, or `readback` for independent per-item verification. `task` checks a UI completion condition. Unknown writes require reconciliation before retry. Fixed preferences compile by revision; changing price, eligibility or item identity needs live facts. The host supplies discovery, authorization and readers. For custom hosts, mark autosave inputs and other implicit writes with `effect: true` on the action so policy and intent guards cover them. Screenshot-only targeting and arbitrary native widgets require further adapter validation; current desktop browser evidence covers macOS.

</details>

<a name="build-with-us"></a>

## 🛠️ Build with us

```sh
npm ci --include=dev
npm run check
npm run test:core
```

Run these checks from a source checkout; they need no browser or model key. For browser regressions, install Chromium and run `npm test`. Keep changes focused; add a regression test for behavior changes. `src/memory` owns learning/replay, `src/proxy` bridges tools, `test` holds fixtures, and `scripts` holds setup and benchmark entry points. For distribution changes, run `npm run release:desktop` then `npm run verify:distribution`.

[MIT License](LICENSE) · [Skill](skills/reflexrun/SKILL.md) · [SDK](src/memory/index.ts) · [Evidence](benchmarks/showcase.json)

<a name="acknowledgements"></a>

## 🙏 Acknowledgements

Thanks to the authors and maintainers of these projects. [Agent Workflow Memory](https://github.com/zorazrw/agent-workflow-memory) · [SkillWeaver](https://github.com/OSU-NLP-Group/SkillWeaver) · [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) · [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Mailpit](https://github.com/axllent/mailpit) · [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)

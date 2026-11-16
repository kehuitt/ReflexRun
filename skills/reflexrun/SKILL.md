---
name: reflexrun
description: Perform ordinary tasks in the current desktop browser or native app through Computer Use. Check local experience before acting, reuse a matching workflow, and learn verified first runs automatically. Use for first-time and repeated GUI tasks and batches, including requests that never mention ReflexRun or memory.
---

Use ReflexRun's bundled runtime with the original Computer Use handles. Derive the operation and inputs from the user's current request. Choose the workflow key internally. Once the host loads this skill, the user can give an ordinary task request and successful first runs are saved automatically. Keep the user's current task and authorization envelope.

Load the desktop Computer Use documentation before using its tools. The runtime expects an existing documented browser tab or native app handle. Match the adapter to the available capabilities.

- A tab with the documented read-only DOM evaluation and locator APIs uses `CuaBrowserHost(tab)`.
- A native app with accessibility state, click and input APIs uses `CuaAppHost(app, scope)`. Use `native:<bundle-id>` for a native app. For a webpage opened through native accessibility, verify the current HTTP(S) address and use `new URL(verifiedPageUrl).origin` as the scope before looking up experience. Check that the workflow's starting screen and controls match before replay.
- Other hosts require a compatible `CallbackHost` or a configured MCP tool proxy.

Import `runtime/memory/index.js` relative to this SKILL.md in the Computer Use JavaScript runtime. These compiled modules require only Node built-ins. Resolve the skill's actual path from its supplied location.

```js
var rr = await import('file:///actual/skill/path/runtime/memory/index.js');
var rrHost = new rr.CuaBrowserHost(tab); // For a native app, use new rr.CuaAppHost(app, scope).
var rrStore = new rr.ExperienceStore();
var rrBefore = await rrHost.observe();
var rrCandidates = await rrStore.discover(rrBefore.scope);
var rrSelected;
```

Before dispatching an action, use the current request and live observation to shortlist candidates by operation. Inspect each plausible path with `await rrStore.get(candidate.id)`. Check that its entry page, goal, actions, input bindings, and constraints fit the requested effect and current context. Pass an exact experience ID only when the match is clear and all required values come from the current request or verified live facts. Leave past record values behind. Use a stable semantic key. A different operation gets its own key, while new parameter values can use the existing operation.

For a new operation, choose the learning path before the first action. Use the typed-goal path below when the host provides an authorized, trustworthy reader for the record. Otherwise use `TaskCapture` so each UI operation and the final verification run in their own active tool call. Both paths save verified workflows as references to shared action steps.

```js
// Set rrSelected to the inspected matching experience or undefined.
var rrTask = {
  key: rrSelected?.key ?? 'semantic-name-of-the-operation',
  ...(rrSelected ? { experience: rrSelected.id } : {}),
  job: 'stable-id-for-this-task-attempt',
  inputs: { title: 'value-from-the-current-task' },
  allowedScopes: [rrBefore.scope],
  verification: 'task',
};
```

Keep `job` stable across interruptions of that attempt. Use `new rr.ExperienceStore()` for the user-level local store shared across chats and projects. Pass a path only when the user explicitly chooses a separate store. The host controls when this skill is loaded. In hosts that require explicit skill invocation, one invocation can cover the ordinary task requests in that chat.

When there is no match, create `TaskCapture` before exploring. Choose actions from its live observations, use semantic locators when available, and set `effect: true` on the action that commits a change if its label alone does not identify it as a write. Declare user-supplied content as task inputs. Use explicit `input` bindings when values currently coincide.

```js
var rrCapture = new rr.TaskCapture(rrHost, rrStore, rrTask);
var rrState = await rrCapture.observe();
// In an active tool call, act on the observed control.
rrState = await rrCapture.act({
  kind: 'fill',
  target: { ref: 'observed-ref' },
  input: 'title',
});
// Choose each next action from the resulting state.
// For a browser textbox that submits on Enter, fill can include submit: true.
var rrSaved = await rrCapture.complete(
  { text: 'exact visible completion text' },
  { parameterCandidates: [{ input: 'title', step: 0, path: 'value' }] },
);
```

Call `complete` with a condition observed after the requested operation that also holds when the same workflow runs with new inputs. `TaskCapture.complete()` returns the saved experience only after verification and persistence. Report any learning error separately from the task outcome. An uncertain dispatched effect needs reconciliation before a retry.

For a clear match, await `new rr.Reflex({ host: rrHost, store: rrStore }).run(rrTask)` in one active tool call and use its returned status and evidence. On a tool host that keeps UI context across calls, `AgentBridge` supports pausing a replay and submitting a bounded repair with `patch(actions)`. When the context is scoped to a single tool call, reconcile the live state before exploring a changed workflow. The runtime checks capabilities, scope, effect count and task policies.

For repeated items with a clear, applicable saved operation, `runMemoryBatch(reflex, options)` runs in one tool call. On a host that keeps UI context across calls, `BatchBridge(rrHost, rrStore, options)` additionally pauses on a representative changed step for repair. Options use `operation` for the learned key, a stable batch `id`, `policy: () => ({ revision: 1, rules: [] })`, and items shaped as `{ id, label, inputs, facts }`. Verify each item's bindings and constraints before choosing batch replay. Use individual attempts when only a particular experience ID is applicable or when an item requires exploration. Compile the user's constraints into the policy and a live fact plan where needed. A repair is reused by remaining items in the same batch.

Honor the user's verification choice. `attempt` records dispatch, `batch` uses a final host audit, and `readback` needs an independent authorized reader supplied by the host. `task` checks the UI condition. Report the evidence actually obtained. Host approval requirements still apply to SDK actions and batch replay.

Call `rrStore.study(key, scope)` to inspect aligned examples, input variation and candidate branches or repetitions. Fixed task preferences belong in constraints or guards. Current prices, eligibility and item identities need live facts. A proposed branch or parameter remains a candidate until supported by task inputs and successful evidence.

### Learning with trusted facts

Use `new rr.CapabilityLibrary(rrStore.directory)` so workflows and cross-task capabilities share the same stored steps. For a typed new goal, first call `library.run({ task, identity, recordKind, goal, host, readFacts })` with `plan` unset. The library checks live identity and authorized effects, skips work already done, and verifies the result. If there is no unique compatible plan, the original agent can resolve the choice through `selectPlan` or explore the task after confirming no actions were dispatched. An uncertain write needs reconciliation before another attempt.

For a browser task with verifiable page routes, create `new rr.CapabilityCapture({ host, store, task, library, readFacts, goal })` before the first exploratory action and use its `observe()` and `act()` throughout. Pass the typed field goals authorized by the current request. The host's reader must independently establish the identity, current and writable fields, protected records and evidence source.

Call `await capture.complete(uiCheck)` after the requested operation. The runtime saves the workflow and derives reusable ranges locally from observed changes. Call `await capture.waitForCapabilities()` to confirm they are ready for the next task. A capture can complete successfully even if some recorded actions cannot be promoted into independently reusable steps. Report an admission error separately from task completion.

Invoke SDK operations that use desktop UI from an active Computer Use tool call and await them there. Keep UI work inside that call when the host assigns a separate execution context to every tool invocation. If the target lacks the structural API required by an adapter, describe the missing capability and use the original agent to finish the task.

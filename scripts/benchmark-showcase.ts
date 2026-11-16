import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodexToolAgent, type ModelTool } from '../src/model/codex.js';
import { ToolProxy, type NativeCall } from '../src/proxy/index.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { runMemoryBatch } from '../src/memory/batch.js';
import type { Action, Check, MemoryResult } from '../src/memory/types.js';
import {
  completeTool,
  contract,
  freshEvaluationDirectory,
  LiveBrowser,
  plain,
  serveUnmodifiedApp,
  parseSettleMs,
} from './live-runtime.js';
import {
  confirmedReadback,
  firstTaskPrompt,
  stamp,
  summarizeTiming,
  taskAttribution,
  exclusiveTiming,
  type TaskTimeline,
  type TimingSpan,
} from './showcase-timing.js';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    out: { type: 'string' },
    evidence: { type: 'string' },
    'no-video': { type: 'boolean' },
    order: { type: 'string', default: 'baseline-first' },
    profile: { type: 'string', default: 'after' },
    'initial-context': { type: 'string', default: 'requested' },
    'settle-ms': { type: 'string', default: '500' },
  },
});
if (!values.app) throw new Error('--app is required; use the pinned, unmodified TodoMVC checkout');
if (!['baseline-first', 'reflex-first'].includes(values.order!))
  throw new Error('--order must be baseline-first or reflex-first');
if (!['before', 'after'].includes(values.profile!))
  throw new Error('--profile must be before or after');
if (!['requested', 'supplied'].includes(values['initial-context']!))
  throw new Error('--initial-context must be requested or supplied');
const hostSettleMs = parseSettleMs(values['settle-ms']!);
const optimized = values.profile === 'after';
const suppliedContext = values['initial-context'] === 'supplied';
const order = values.order === 'reflex-first' ? ['reflex', 'baseline'] : ['baseline', 'reflex'];
if (values.out) {
  try {
    await access(resolve(values.out));
    throw new Error('--out already exists; preserve prior evidence and choose a new file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const directory = await freshEvaluationDirectory(values.evidence);
const appRoot = resolve(values.app),
  app = await serveUnmodifiedApp(appRoot);
const started = stamp();
const git = (...args: string[]) =>
  execFileSync('git', ['-C', appRoot, ...args], { encoding: 'utf8' }).trim();
const titles = [
  'Learn the workflow',
  'Reserve tennis court',
  'Review project draft',
  'Buy fresh vegetables',
  'Prepare seminar notes',
  'Read a research paper',
  'Plan the weekend',
];
const report: Record<string, any> = {
  schemaVersion: 3,
  started,
  directory,
  task: 'Create one exact TodoMVC task for each supplied title, retaining all prior records',
  titles,
  site: {
    repository: 'https://github.com/1Marc/modern-todomvc-vanillajs',
    commit: git('rev-parse', 'HEAD'),
    modifiedBefore: git('status', '--porcelain'),
  },
  verification: contract,
  viewport: { width: 1280, height: 800 },
  video: !values['no-video'],
  hostSettleMs,
  codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  playwrightMcp: JSON.parse(
    await readFile(resolve('node_modules/@playwright/mcp/package.json'), 'utf8'),
  ).version,
  fairness: {
    order,
    profile: values.profile,
    initialContext: values['initial-context'],
    hostSettleMs,
    optimizations: [
      ...(suppliedContext
        ? ['same fresh initial-context policy for both methods', 'reuse native action snapshots']
        : []),
      ...(optimized
        ? ['repair schema limited to failed native tool', 'stop repair at validated bounded patch']
        : []),
    ],
    repetitions: 1,
    baselineContext:
      'One continuous live model turn for the cold item and all six queued items, retaining its prior tool context; no restart per item',
    reflexContext:
      'One fresh live model turn for the cold task, then local replay; one fresh bounded model turn repairs the renamed control',
    coldPrompt:
      'Both receive the same first-task instruction and initial-context policy, separately selected from the repair profile. Requested leaves initial observation to the model. Supplied gives each its own fresh live snapshot and a prompt to reuse action-response snapshots; snapshot bytes include their actual isolated session values and need not be identical. The baseline completion responses reveal the remaining queue, retaining its continuous model context; the ReflexRun learning response ends the queue.',
    internalValidationDifference:
      'Both receive the identical independent-storage predicate. Baseline records the declared UI goal; ReflexRun additionally checks its learned UI completion condition and applies its normal scope/intent safeguards. Their extra work is included, not imposed on the unassisted agent.',
    timing:
      'taskReadyMs is the comparable first-task metric: both stop at the same independent storage readback returning confirmed. memoryReadyMs records successful durable learning separately, while modelTurnReadyMs and modelTailMs record the learning model turn and its post-task tail. These milestones may overlap and must not be added. Baseline uses one continuous seven-item model turn, so it has no first-item model-turn/tail metric. Legacy elapsedMs retains historical mixed boundaries and must not rank cold starts. Browser/app startup and evaluator-induced renaming are excluded.',
    recording:
      'Both methods use identical native Playwright context video settings. No animation or pacing waits are added. --no-video repeats without encoder overhead.',
    limits:
      'One pair per invocation on one synthetic app; campaign counterbalances order. Not a randomized statistical speed ranking or a guarantee for arbitrary sites',
  },
  results: {},
  modelRuns: [],
  events: [],
  completed: false,
};
const save = () =>
  writeFile(join(directory, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const agent = (method: string, phase: string) =>
  new CodexToolAgent({
    cwd: join(directory, 'model-cwd'),
    timeoutMs: method === 'baseline' ? 300_000 : 180_000,
    onEvent: (event) => {
      const row = {
        ...event,
        ...(event.type.startsWith('rpc-') ? { rpcMethod: event.method } : {}),
        method,
        phase,
        monotonicMs: typeof event.monotonicMs === 'number' ? event.monotonicMs : performance.now(),
        offsetMs: performance.now() - started.monotonicMs,
      };
      report.events.push(row);
      appendFileSync(join(directory, 'model-events.jsonl'), JSON.stringify(row) + '\n');
      if (['model-start', 'tool-request', 'failed'].includes(event.type))
        process.stderr.write(
          `${method}/${phase}: ${event.type} ${event.tool ?? event.error ?? event.model ?? ''}\n`,
        );
    },
  });
const toolsFor = async (browser: LiveBrowser): Promise<ModelTool[]> =>
  (await browser.tools()).map(({ name, description, inputSchema }) => ({
    name,
    description: description ?? name,
    inputSchema,
  }));
const hash = (tools: ModelTool[]) =>
  createHash('sha256').update(JSON.stringify(tools)).digest('hex');
const text = (value: unknown) => [{ type: 'inputText' as const, text: JSON.stringify(value) }];
const payloadWithoutTargets = (value: unknown, paths: Set<string>, path = ''): unknown => {
  if (paths.has(path)) return null;
  if (Array.isArray(value))
    return value.map((item, index) =>
      payloadWithoutTargets(item, paths, path ? `${path}.${index}` : String(index)),
    );
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [
          key,
          payloadWithoutTargets(item, paths, path ? `${path}.${key}` : key),
        ]),
    );
  return value;
};
async function measured<T>(
  result: Record<string, any>,
  kind: string,
  name: string,
  run: () => Promise<T>,
) {
  const startMs = performance.now();
  try {
    return await run();
  } finally {
    result.spans.push({ kind, name, startMs, endMs: performance.now() });
  }
}
const attribution = (
  method: string,
  phase: string,
  timeline: TaskTimeline,
  end = timeline.taskReady,
) => {
  if (!end) return undefined;
  const result = report.results[method];
  const measured = taskAttribution(
    timeline.started.monotonicMs,
    end.monotonicMs,
    report.events.filter((e: any) => e.method === method && e.phase === phase),
    result.spans,
  );
  const proxySpans = result.proxyTimings.map((event: any) => ({
    kind: event.stage,
    startMs: event.startedMs,
    endMs: event.endedMs,
  }));
  const proxyLeaf = exclusiveTiming(timeline.started.monotonicMs, end.monotonicMs, proxySpans, [
    'upstream',
    'authorization',
    'parse',
  ]).buckets;
  delete proxyLeaf.unattributed;
  return {
    ...measured,
    startupRpc: Object.fromEntries(
      ['initializeMs', 'threadStartMs', 'turnStartRpcMs'].flatMap((key) => {
        const value = report.modelRuns.find(
          (run: any) => run.method === method && run.phase === phase,
        )?.timings?.[key];
        return typeof value === 'number' ? [[key, value]] : [];
      }),
    ),
    proxy:
      method === 'reflex'
        ? {
            leaf: proxyLeaf,
            inclusiveTranslationMs: exclusiveTiming(
              timeline.started.monotonicMs,
              end.monotonicMs,
              proxySpans,
              ['translate'],
            ).buckets.translate,
          }
        : undefined,
  };
};
async function open(method: string) {
  const result: Record<string, any> = (report.results[method] = {
    browserLaunch: stamp(),
    rows: [],
    phases: [],
    evaluatorEvents: [],
    spans: [] as TimingSpan[],
    proxyTimings: [],
    observedReadbacks: [],
  });
  const browser = await LiveBrowser.open(app.origin, method, directory, {
    recordVideo: !values['no-video'],
    settleMs: hostSettleMs,
    onPageCreated: (time) => {
      result.pageCreated = time;
    },
  });
  result.browserReady = stamp();
  const call = browser.port.callTool.bind(browser.port),
    verify = browser.verify.bind(browser);
  browser.port.callTool = (native) => measured(result, 'native', native.name, () => call(native));
  browser.verify = (title) =>
    measured(result, 'readback', 'independent-storage', async () => {
      const outcome = await verify(title);
      result.observedReadbacks.push({ title, ...outcome, observed: stamp() });
      return outcome;
    });
  result.tools = [...(await toolsFor(browser)), completeTool];
  result.toolsSha256 = hash(result.tools);
  return browser;
}
async function close(method: string, browser: LiveBrowser) {
  const result = report.results[method],
    video = browser.page.video();
  result.browserClosing = stamp();
  await browser.close();
  result.browserClosed = stamp();
  if (video) {
    result.sourceVideoPath = await video.path();
    result.rawVideo = join(directory, method + '.webm');
    await copyFile(result.sourceVideoPath, result.rawVideo);
    result.videoTimebase =
      'Playwright page-created event anchors the timeline; the first encoded frame can lag that event. Browser closing/closed bound the final encoder flush. No footage has been sped up.';
  }
  await save();
}
async function baseline() {
  const browser = await open('baseline'),
    result = report.results.baseline;
  const tools = result.tools as ModelTool[];
  let index = 0,
    itemStarted = stamp();
  const coldTiming: TaskTimeline = { started: itemStarted };
  result.executionStarted = itemStarted;
  try {
    const initialSnapshot = suppliedContext
      ? await measured(result, 'preflight', 'initial-snapshot', async () =>
          plain(await browser.port.callTool({ name: 'browser_snapshot', arguments: {} })),
        )
      : undefined;
    const run = await agent('baseline', 'continuous-queue').run(
      firstTaskPrompt(titles[0], initialSnapshot),
      tools,
      async (name, args) => {
        if (name === 'task_complete') {
          assert.ok(index < titles.length, 'All requested items are already complete');
          const outcome =
            index === 0
              ? await confirmedReadback(coldTiming, () => browser.verify(titles[index]))
              : await browser.verify(titles[index]);
          assert.equal(outcome.status, 'confirmed', JSON.stringify(outcome));
          const ended = index === 0 ? coldTiming.taskReady! : stamp();
          result.rows.push({
            index,
            title: titles[index],
            phase: index === 0 ? 'cold' : index <= 3 ? 'normal' : 'changed',
            started: itemStarted,
            ended,
            elapsedMs: ended.monotonicMs - itemStarted.monotonicMs,
            outcome,
            declaredGoal: args.goal,
          });
          index++;
          await save();
          if (index === 4) {
            const before = stamp();
            await browser.renameInput();
            result.evaluatorEvents.push({
              type: 'rename-control',
              before,
              after: stamp(),
              newName: 'Add the next task',
            });
          }
          itemStarted = stamp();
          return text({
            outcome,
            nextTitle: titles[index] ?? null,
            remaining: titles.length - index,
          });
        }
        const value = await browser.port.callTool({
          name,
          arguments: args as NativeCall['arguments'],
        });
        return [{ type: 'inputText', text: plain(value) }];
      },
    );
    report.modelRuns.push({ ...run, method: 'baseline', phase: 'continuous-queue' });
    assert.equal(index, titles.length, 'The original model did not finish the whole queue');
    result.modelTurnCompleted = stamp();
    result.continuousModelTurnReadyMs =
      result.modelTurnCompleted.monotonicMs - result.executionStarted.monotonicMs;
    result.tailAfterLastCompletionMs =
      result.modelTurnCompleted.monotonicMs - result.rows.at(-1).ended.monotonicMs;
    result.finalRecords = await browser.records();
    result.phases = ['cold', 'normal', 'changed'].map((phase) => ({
      phase,
      elapsedMs: result.rows
        .filter((row: any) => row.phase === phase)
        .reduce((sum: number, row: any) => sum + row.elapsedMs, 0),
      confirmed: result.rows.filter((row: any) => row.phase === phase).length,
      ...(phase === 'cold'
        ? {
            ...summarizeTiming(coldTiming),
            timing: coldTiming,
            attribution: attribution('baseline', 'continuous-queue', coldTiming),
          }
        : {}),
    }));
  } finally {
    await close('baseline', browser);
  }
}
async function reflex() {
  const browser = await open('reflex'),
    result = report.results.reflex;
  const tools = result.tools as ModelTool[],
    store = new ExperienceStore(join(directory, 'reflex-memory')),
    proxy = new ToolProxy(browser.port, store, undefined, {
      onTiming: (event) => result.proxyTimings.push(event),
    });
  await proxy.host.initialize();
  try {
    const coldStarted = stamp();
    const coldTiming: TaskTimeline = { started: coldStarted };
    const first = await measured(result, 'preflight', 'proxy-begin', () =>
      proxy.begin({
        key: 'showcase.todo.create',
        job: 'cold',
        inputs: { title: titles[0] },
        verification: 'readback',
        readback: () => confirmedReadback(coldTiming, () => browser.verify(titles[0])),
      }),
    );
    assert.equal(first.mode, 'explore');
    let completion: any;
    let learning: Promise<MemoryResult> | undefined;
    const run = await agent('reflex', 'cold').run(
      firstTaskPrompt(titles[0], suppliedContext ? first.observation.text : undefined),
      tools,
      async (name, args) => {
        if (name === 'task_complete') {
          completion = await proxy.finish(args.goal as Check);
          learning = proxy.waitForLearning().then((result) => {
            assert.ok(result, 'The active capture must retain its final learning result');
            if (result.learning === 'ready') coldTiming.memoryReady = stamp();
            return result;
          });
          return text({ ...completion, nextTitle: null, remaining: 0 });
        }
        const value = await proxy.call({ name, arguments: args as NativeCall['arguments'] });
        return [{ type: 'inputText', text: plain(value) }];
      },
    );
    coldTiming.modelTurnReady = stamp();
    report.modelRuns.push({ ...run, method: 'reflex', phase: 'cold' });
    assert.equal(completion?.result.status, 'completed', JSON.stringify(completion));
    assert.ok(learning, 'The completion must start a separately observable learning result');
    const learned = await learning;
    assert.equal(learned.learning, 'ready', learned.learningError ?? JSON.stringify(learned));
    assert.equal(
      (await store.list()).length,
      1,
      'The genuine first model path must automatically persist',
    );
    result.phases.push({
      phase: 'cold',
      started: coldStarted,
      ended: stamp(),
      elapsedMs: performance.now() - coldStarted.monotonicMs,
      legacyBoundary: 'Through learning-model turn completion and persisted-memory assertion',
      ...summarizeTiming(coldTiming),
      timing: coldTiming,
      attribution: attribution('reflex', 'cold', coldTiming),
      localTimings: learned.timings && {
        observationMs: learned.timings.observationMs,
        checkMs: learned.timings.checkMs,
        compileMs: learned.timings.compileMs,
        persistMs: learned.timings.persistMs,
      },
      result: learned,
    });
    result.memoryAfterCold = await store.list();
    await save();
    let repairs = 0;
    const runner = new Reflex({
      host: proxy.host,
      store: new ExperienceStore(store.directory),
      repair: async (context) => {
        repairs++;
        let calls: NativeCall[] | undefined;
        let translated: Action[] | undefined;
        const candidates = tools.filter((tool) =>
          optimized ? tool.name === context.failed.tool : tool.name !== 'task_complete',
        );
        assert.ok(candidates.length, 'The failed native tool schema must exist');
        const patch: ModelTool = {
          name: 'submit_patch',
          description:
            'Propose the bounded native replacement for the failed browser action. Do not execute a write yourself.',
          inputSchema: {
            type: 'object',
            properties: {
              calls: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                items: {
                  anyOf: candidates.map((tool) => ({
                    type: 'object',
                    properties: { name: { const: tool.name }, arguments: tool.inputSchema },
                    required: ['name', 'arguments'],
                    additionalProperties: false,
                  })),
                },
              },
            },
            required: ['calls'],
            additionalProperties: false,
          },
        };
        const repairStarted = stamp();
        const repairAgent = agent('reflex', 'repair');
        const instruction = `A learned browser action no longer resolves before dispatch. Use the live snapshot and propose submit_patch with the original native tool name and arguments. Do not execute a write. ${optimized ? 'The current live snapshot is already supplied; request another only if needed. Change only the failed native tool target, retaining the original values and effect boundary. Submit the bounded patch directly once it is grounded.' : ''} Task inputs: ${JSON.stringify(context.task.inputs)}. Failed call: ${JSON.stringify({ name: context.failed.tool, arguments: context.failed.args })}. Observation: ${context.observation.text}`;
        const repairTools = [tools.find((tool) => tool.name === 'browser_snapshot')!, patch],
          repairCall = async (name: string, args: Record<string, unknown>) => {
            if (name === 'submit_patch') {
              const proposed = args.calls as NativeCall[];
              assert.ok(
                Array.isArray(proposed) && proposed.length > 0 && proposed.length <= 3,
                'A repair must return one to three native calls',
              );
              assert.ok(
                proposed.every((call) => candidates.some((tool) => tool.name === call.name)),
                'Patch used a native tool outside the supplied schema',
              );
              if (optimized) {
                assert.equal(proposed.length, 1, 'Target repair must preserve one original action');
                const targets = new Set(Object.keys(context.failed.bindings ?? {}));
                assert.deepEqual(
                  payloadWithoutTargets(proposed[0].arguments, targets),
                  payloadWithoutTargets(context.failed.args, targets),
                  'Target repair changed the original non-target payload',
                );
              }
              // Translation validates live refs before the bounded result is accepted.
              translated = await Promise.all(proposed.map((call) => proxy.host.translate(call)));
              calls = proposed;
              result.repairPatchReady = stamp();
              return text({ received: true });
            }
            return [
              {
                type: 'inputText' as const,
                text: plain(
                  await browser.port.callTool({ name, arguments: args as NativeCall['arguments'] }),
                ),
              },
            ];
          };
        const repaired = optimized
          ? await repairAgent.runUntilTool(instruction, repairTools, repairCall, 'submit_patch')
          : await repairAgent.run(instruction, repairTools, repairCall);
        report.modelRuns.push({ ...repaired, method: 'reflex', phase: 'repair' });
        result.repair = {
          started: repairStarted,
          ended: stamp(),
          calls,
          profile: values.profile,
          patchReadyMs: result.repairPatchReady
            ? result.repairPatchReady.monotonicMs - repairStarted.monotonicMs
            : undefined,
          elapsedMs: performance.now() - repairStarted.monotonicMs,
          modelStatus: repaired.status,
          modelTimings: repaired.timings,
          attribution: attribution('reflex', 'repair', { started: repairStarted }, stamp()),
          toolSchemaBytes: Buffer.byteLength(JSON.stringify(patch.inputSchema)),
          offeredToolCount: repairTools.length,
          toolSchema: patch.inputSchema,
        };
        assert.ok(calls?.length, 'A repair must return bounded original-tool calls');
        assert.ok(translated?.length, 'A repair must retain its validated translation');
        return translated;
      },
    });
    const items = titles
      .slice(1)
      .map((title, index) => ({ id: 'item-' + index, label: title, facts: {}, inputs: { title } }));
    for (const phase of ['normal', 'changed']) {
      if (phase === 'changed') {
        const before = stamp();
        await browser.renameInput();
        result.evaluatorEvents.push({
          type: 'rename-control',
          before,
          after: stamp(),
          newName: 'Add the next task',
        });
      }
      const phaseStarted = stamp(),
        previousRepairs = repairs;
      const batch = await runMemoryBatch(runner, {
        id: 'showcase-six',
        operation: 'showcase.todo.create',
        verification: 'readback',
        policy: () => ({ revision: 1, rules: [] }),
        items: phase === 'normal' ? items.slice(0, 3) : items,
        allowedScopes: [app.origin],
        timeoutMs: 240_000,
        readback: (item) => browser.verify(String(item.inputs.title)),
        onItem: (row, itemResult) => {
          result.rows.push({ ...row, phase, observed: stamp(), result: itemResult });
        },
      });
      result.phases.push({
        phase,
        started: phaseStarted,
        ended: stamp(),
        elapsedMs: performance.now() - phaseStarted.monotonicMs,
        repairs: repairs - previousRepairs,
        batch,
      });
      await save();
      assert.ok(
        batch.rows.every((row) => row.status === 'confirmed'),
        JSON.stringify(batch.rows),
      );
      if (phase === 'changed')
        assert.equal(repairs - previousRepairs, 1, 'One repair must serve the whole changed batch');
    }
    result.finalRecords = await browser.records();
    result.memories = await store.list();
  } finally {
    proxy.cancel();
    await close('reflex', browser);
  }
}
try {
  assert.equal(report.site.modifiedBefore, '', 'The application checkout must be unmodified');
  for (const method of order) await (method === 'baseline' ? baseline() : reflex());
  report.fairness.toolsIdentical =
    report.results.baseline.toolsSha256 === report.results.reflex.toolsSha256;
  report.fairness.modelsIdentical =
    new Set(
      report.modelRuns.map((run: any) =>
        JSON.stringify([run.model, run.provider, run.reasoningEffort]),
      ),
    ).size === 1;
  assert.ok(
    report.fairness.toolsIdentical && report.fairness.modelsIdentical,
    'Both methods require the same initial tools and model configuration',
  );
  for (const method of ['baseline', 'reflex'])
    assert.deepEqual(
      report.results[method].finalRecords.map((row: any) => row.title),
      titles,
    );
  report.completed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  report.ended = stamp();
  report.site.modifiedAfter = git('status', '--porcelain');
  if (report.site.modifiedAfter) {
    report.completed = false;
    report.error = 'The application checkout changed during evaluation';
    process.exitCode = 1;
  }
  await save();
  await app.close();
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  process.stderr.write(`Saved private evidence: ${directory}\nCompleted: ${report.completed}\n`);
}

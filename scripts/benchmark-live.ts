import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CodexToolAgent, type ModelEvent, type ModelRun } from '../src/model/codex.js';
import { ToolProxy, type NativeCall } from '../src/proxy/index.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { runMemoryBatch } from '../src/memory/batch.js';
import type { Check } from '../src/memory/types.js';
import {
  completeTool,
  contract,
  freshEvaluationDirectory,
  LiveBrowser,
  plain,
  serveUnmodifiedApp,
  finalizeLiveEvidence,
} from './live-runtime.js';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    items: { type: 'string', default: '100' },
    out: { type: 'string' },
    'reflex-only': { type: 'boolean' }, // Accept the previous standalone flag.
  },
});
for (const flag of ['app', 'out'] as const)
  if (!values[flag]) throw new Error(`--${flag} is required`);
const count = Number(values.items);
if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('items must be 2..100');
const directory = await freshEvaluationDirectory(),
  appRoot = resolve(values.app!),
  app = await serveUnmodifiedApp(appRoot);
const nonce = Math.random().toString(36).slice(2, 8);
const events: ModelEvent[] = [],
  modelRuns: (ModelRun & { phase: string; method: string })[] = [];
const git = (...args: string[]) =>
  execFileSync('git', ['-C', appRoot, ...args], { encoding: 'utf8' }).trim();
let prior: any;
try {
  prior = JSON.parse(await readFile(resolve(values.out!), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const report: Record<string, any> = {
  recordedAt: new Date().toISOString(),
  directory,
  task: 'Create one new TodoMVC task with exactly the supplied title',
  provider:
    'Installed Codex app-server with existing managed ChatGPT login; no credentials read by ReflexRun',
  site: {
    repository: 'https://github.com/1Marc/modern-todomvc-vanillajs',
    commit: git('rev-parse', 'HEAD'),
    modifiedBefore: git('status', '--porcelain'),
  },
  verification: contract,
  items: count,
  modelRuns,
  events,
  results: {},
  validationPassed: false,
  fairness: {
    scope:
      'Non-production UI execution under one common independent-storage contract; production eligibility is reported separately',
  },
  previousAttempts: prior
    ? [
        ...(prior.previousAttempts ?? []),
        {
          recordedAt: prior.recordedAt,
          directory: prior.directory,
          error: prior.error,
          results: prior.results,
          modelRuns: prior.modelRuns,
          events: prior.events,
        },
      ]
    : [],
};
const save = () => writeFile(resolve(values.out!), JSON.stringify(report, null, 2) + '\n');
const model = (method: string, phase: string) =>
  new CodexToolAgent({
    cwd: join(directory, 'model-cwd'),
    timeoutMs: 300_000,
    onEvent: (event) => {
      events.push({ ...event, method, phase });
      if (['model-start', 'tool-request', 'failed'].includes(event.type))
        process.stderr.write(
          `${method}/${phase}: ${event.type} ${event.tool ?? event.model ?? event.error ?? ''}\n`,
        );
    },
  });
const instruction = (title: string) =>
  `You are on a TodoMVC page already open in the browser. Create exactly one new task whose title is ${JSON.stringify(title)}. Discover the controls from the current interface. Leave existing records unchanged. When it is visibly created, call task_complete with an observed UI completion condition.`;

async function reflex() {
  const browser = await LiveBrowser.open(app.origin, 'reflex', directory);
  app.readers.set('reflex', () => browser.records());
  const store = new ExperienceStore(join(directory, 'reflex-memory')),
    proxy = new ToolProxy(browser.port, store);
  await proxy.host.initialize();
  const tools = (await browser.tools()).map(({ name, description, inputSchema }) => ({
    name,
    description: description ?? name,
    inputSchema,
  }));
  report.fairness.reflexToolsSha256 = createHash('sha256')
    .update(JSON.stringify([...tools, completeTool]))
    .digest('hex');
  const title = `task-${nonce}-cold`,
    at = performance.now();
  let completed = false,
    completion: any;
  try {
    await browser.shot(join(directory, 'reflex-before.png'));
    const first = await proxy.begin({
      key: 'unadapted.todo.create',
      job: 'cold',
      inputs: { title },
      verification: 'readback',
      readback: () => browser.verify(title),
    });
    assert.equal(first.mode, 'explore');
    const cold = await model('reflex', 'cold').run(
      instruction(title),
      [...tools, completeTool],
      async (name, args) => {
        if (name === 'task_complete') {
          completion = await proxy.finish(args.goal as Check);
          completed = true;
          return [{ type: 'inputText', text: JSON.stringify(completion) }];
        }
        const result = await proxy.call({ name, arguments: args } as NativeCall);
        if (result.isError) throw new Error(plain(result));
        return [{ type: 'inputText', text: plain(result) }];
      },
    );
    modelRuns.push({ ...cold, method: 'reflex', phase: 'cold' });
    assert.ok(completed, 'The model must declare completion');
    assert.equal(completion.result.status, 'completed', JSON.stringify(completion));
    const learned = await proxy.waitForLearning();
    assert.equal(learned?.learning, 'ready', learned?.learningError);
    assert.equal(
      (await store.list()).length,
      1,
      'The actual first model run must automatically persist an experience',
    );
    await browser.shot(join(directory, 'reflex-learned.png'));
    report.results.reflex = {
      cold: {
        elapsedMs: Math.round(performance.now() - at),
        result: completion.result,
        memory: (await store.list())[0].id,
      },
      phases: [],
    };
    await save();
    let repairs = 0;
    const runner = new Reflex({
      host: proxy.host,
      store: new ExperienceStore(store.directory),
      repair: async (context) => {
        repairs++;
        let calls: NativeCall[] | undefined;
        const patchTool = {
          name: 'submit_patch',
          description:
            'Return a bounded replacement for the failed native browser call. Do not execute it yourself. Preserve the requested task and effect boundary.',
          inputSchema: {
            type: 'object',
            properties: {
              calls: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    arguments: { type: 'object', additionalProperties: true },
                  },
                  required: ['name', 'arguments'],
                  additionalProperties: false,
                },
              },
            },
            required: ['calls'],
            additionalProperties: false,
          },
        };
        const repair = await model('reflex', 'repair').run(
          `A learned browser action no longer resolves before dispatch. Repair the failed call from the live interface and return submit_patch. Do not perform a write. Current task inputs: ${JSON.stringify(context.task.inputs)}. Failed call: ${JSON.stringify({ name: context.failed.tool, arguments: context.failed.args })}. Current observation:\n${context.observation.text}`,
          [tools.find((tool) => tool.name === 'browser_snapshot')!, patchTool],
          async (name, args) => {
            if (name === 'submit_patch') {
              calls = args.calls as NativeCall[];
              return [
                {
                  type: 'inputText',
                  text: 'Patch received; it will be checked and executed by the existing host.',
                },
              ];
            }
            const result = await browser.port.callTool({ name: 'browser_snapshot', arguments: {} });
            return [{ type: 'inputText', text: plain(result) }];
          },
        );
        modelRuns.push({ ...repair, method: 'reflex', phase: 'repair' });
        assert.ok(calls?.length);
        return Promise.all(calls.map((call) => proxy.host.translate(call)));
      },
    });
    report.results.reflex.faults = await browser.faultCases(async (title) => {
      const beforeVerification = browser.verificationMs;
      const result = await runner.run({
        key: 'unadapted.todo.create',
        job: 'fault-' + title,
        inputs: { title },
        verification: 'readback',
        allowedScopes: [app.origin],
        readback: () => browser.verify(title),
      });
      return { ...result, verificationMs: Math.round(browser.verificationMs - beforeVerification) };
    }, `task-${nonce}-fault`);
    await save();
    const items = Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      label: 'Create synthetic task',
      facts: {},
      inputs: { title: `task-${nonce}-batch-${String(i).padStart(3, '0')}` },
    }));
    const split = Math.floor(count / 2);
    for (const phase of ['normal', 'changed']) {
      if (phase === 'changed') await browser.renameInput();
      const beforeRepairs = repairs,
        reads = browser.reads,
        beforeVerification = browser.verificationMs,
        started = performance.now();
      const result = await runMemoryBatch(runner, {
        id: 'live-whole-batch',
        operation: 'unadapted.todo.create',
        items: phase === 'normal' ? items.slice(0, split) : items,
        verification: 'readback',
        policy: () => ({ revision: 1, rules: [] }),
        allowedScopes: [app.origin],
        timeoutMs: 300_000,
        readback: (item) => browser.verify(String(item.inputs.title)),
        onItem: (row) => process.stderr.write(`reflex/${phase}: ${row.id} ${row.status}\n`),
      });
      report.results.reflex.phases.push({
        phase,
        elapsedMs: Math.round(performance.now() - started),
        verificationMs: Math.round(browser.verificationMs - beforeVerification),
        repairs: repairs - beforeRepairs,
        recordReads: browser.reads - reads,
        result,
      });
      await save();
      assert.ok(
        result.rows.every((row) => row.status === 'confirmed'),
        JSON.stringify(result.rows.filter((row) => row.status !== 'confirmed')),
      );
      if (phase === 'changed')
        assert.equal(repairs - beforeRepairs, 1, 'One model repair must serve all changed items');
    }
    assert.equal((await browser.records()).length, count + 1);
    await browser.shot(join(directory, 'reflex-batch.png'));
    report.results.reflex.persistedAfterRestart = (
      await new ExperienceStore(store.directory).list()
    ).map((memory) => ({ id: memory.id, parent: memory.parent, steps: memory.steps.length }));
    report.results.reflex.finalRecords = await browser.records();
    await save();
  } finally {
    await browser.close();
  }
}

try {
  await reflex();
  report.validationPassed = true;
  report.reflexValidationPassed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  report.site.modifiedAfter = git('status', '--porcelain');
  try {
    await finalizeLiveEvidence(report);
    await save();
  } finally {
    await app.close();
  }
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright';
import { CodexToolAgent, type ModelContent, type ModelTool } from '../src/model/codex.js';
import { ToolProxy, type NativeCall } from '../src/proxy/index.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { runMemoryBatch } from '../src/memory/batch.js';
import type { Action, Check, Experience, Inputs, MemoryResult } from '../src/memory/types.js';
import {
  completeTool,
  LiveBrowser,
  parseSettleMs,
  plain,
  targetOnlyNativePatch,
} from './live-runtime.js';
import { MailpitEvaluation } from './mailpit-evaluation.js';
import { confirmedReadback, stamp, summarizeTiming, type TaskTimeline } from './showcase-timing.js';

type Method = 'baseline' | 'reflex';
type Phase = 'cold' | 'normal' | 'changed';
type Handler = Parameters<CodexToolAgent['run']>[2];
export type FaultPlan = {
  target: { role: 'textbox' | 'searchbox' | 'combobox'; name?: string; placeholder?: string };
  replacement: string;
  sourceExperience: string;
  sourceStep: number;
  input: string;
  sourceTarget: Action['target'];
};
const content = (value: unknown): ModelContent[] => [
  { type: 'inputText', text: JSON.stringify(value) },
];
const phaseAt = (index: number): Phase => (index === 0 ? 'cold' : index < 4 ? 'normal' : 'changed');
const toolsOffered = [
  'browser_snapshot',
  'browser_type',
  'browser_press_key',
  'browser_click',
  'browser_navigate_back',
  'browser_fill_form',
  'browser_select_option',
];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A failed phase cannot borrow the prior phase's confirmation timestamp. */
export function phaseTiming(
  started: ReturnType<typeof stamp>,
  confirmed?: ReturnType<typeof stamp>,
  batchReady?: ReturnType<typeof stamp>,
) {
  const businessReady =
    confirmed && confirmed.monotonicMs >= started.monotonicMs ? confirmed : undefined;
  return {
    started,
    businessReady,
    businessReadyMs: businessReady ? businessReady.monotonicMs - started.monotonicMs : undefined,
    ...(batchReady
      ? {
          batchReady,
          batchReadyMs: batchReady.monotonicMs - started.monotonicMs,
          persistenceTailMs: businessReady
            ? batchReady.monotonicMs - businessReady.monotonicMs
            : undefined,
        }
      : {}),
  };
}

/** Identical sequencing for both methods, including ordinary unbounded model turns. */
export function serialHandler(handler: Handler): Handler {
  let queue = Promise.resolve();
  return (name, args) => {
    const pending = queue.then(() => handler(name, args));
    queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
}
const references = (value: unknown, input: string): boolean => {
  if (!value || typeof value !== 'object') return false;
  if ('$input' in value && value.$input === input) return true;
  return Object.values(value).some((child) => references(child, input));
};

/** Derive the fault from controls used by the first real model; no website selector map. */
export function deriveFaultPlan(experience: Experience): FaultPlan {
  for (const input of ['subject', 'tag']) {
    for (const [index, step] of experience.steps.entries()) {
      const action = step.action as unknown as Action;
      const targets =
        action.tool === 'browser_type' && references(action.args?.text, input)
          ? [action.bindings?.target ?? action.bindings?.ref]
          : action.tool === 'browser_fill_form' && Array.isArray(action.args?.fields)
            ? action.args.fields.flatMap((field, i) =>
                references(field, input)
                  ? [
                      action.bindings?.['fields.' + i + '.target'] ??
                        action.bindings?.['fields.' + i + '.ref'],
                    ]
                  : [],
              )
            : [];
      for (const target of targets) {
        if (
          !target ||
          !['textbox', 'searchbox', 'combobox'].includes(target.role ?? '') ||
          target.index !== undefined ||
          (target.within !== undefined && typeof target.within !== 'string') ||
          target.frames?.length
        )
          continue;
        const name = typeof target.name === 'string' && target.name ? target.name : undefined;
        const placeholder =
          typeof target.placeholder === 'string' && target.placeholder
            ? target.placeholder
            : undefined;
        if (!name && !placeholder) continue;
        return {
          target: {
            role: target.role as FaultPlan['target']['role'],
            ...(name ? { name } : {}),
            ...(placeholder ? { placeholder } : {}),
          },
          replacement: 'Updated input',
          sourceExperience: experience.id,
          sourceStep: index,
          input,
          sourceTarget: structuredClone(target),
        };
      }
    }
  }
  throw new Error(
    'The first real experience has no unique static parameter-input target for the declared label-drift test',
  );
}

export async function installDrift(page: Page, plan: FaultPlan) {
  const locator = plan.target.name
    ? page.getByRole(plan.target.role, { name: plan.target.name, exact: true })
    : page.getByPlaceholder(plan.target.placeholder!, { exact: true }).filter({ visible: true });
  assert.ok((await locator.count()) <= 1, 'The model-derived fault target is ambiguous');
  await page.evaluate((plan) => {
    const state = {
      patches: 0,
      nodes: 0,
      active: true,
      ambiguous: false,
      ambiguousObservations: 0,
      observations: [] as {
        at: number;
        matched: number;
        visibleMatches: number;
        patches: number;
        ambiguous: boolean;
      }[],
    };
    const seen = new WeakSet<Element>();
    const old = plan.target.name ?? plan.target.placeholder!;
    // Methods stay self-contained when tsx serializes this callback for the browser.
    const controller = {
      role(node: Element) {
        return (
          node.getAttribute('role') ??
          (node instanceof HTMLTextAreaElement
            ? 'textbox'
            : node instanceof HTMLInputElement
              ? node.type === 'search'
                ? 'searchbox'
                : 'textbox'
              : '')
        );
      },
      name(node: Element) {
        return (
          node.getAttribute('aria-label') ||
          (node.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim() ||
          ('labels' in node
            ? Array.from((node as HTMLInputElement).labels ?? [])
                .map((label) => label.textContent)
                .join(' ')
                .trim()
            : '') ||
          node.getAttribute('placeholder') ||
          node.getAttribute('title') ||
          ''
        );
      },
      visible(node: Element) {
        return (
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility === 'visible' &&
          !node.closest('[aria-hidden="true"],[hidden],[inert]')
        );
      },
      apply() {
        const semanticMatches = Array.from(
          document.querySelectorAll(
            'input,textarea,[role="textbox"],[role="searchbox"],[role="combobox"]',
          ),
        ).filter(
          (node) =>
            controller.role(node) === plan.target.role &&
            [old, plan.replacement].includes(controller.name(node)),
        );
        const matches = semanticMatches.filter((node) => controller.visible(node));
        state.ambiguous = matches.length > 1;
        if (state.ambiguous) state.ambiguousObservations++;
        state.observations.push({
          at: performance.now(),
          matched: semanticMatches.length,
          visibleMatches: matches.length,
          patches: state.patches,
          ambiguous: state.ambiguous,
        });
        // A transient second visible control is evidence, not permission to rename both.
        if (state.ambiguous) return;
        for (const node of matches) {
          if (!seen.has(node)) {
            seen.add(node);
            state.nodes++;
          }
          if (
            node.getAttribute('aria-label') !== plan.replacement ||
            (node.hasAttribute('placeholder') &&
              node.getAttribute('placeholder') !== plan.replacement)
          ) {
            node.setAttribute('aria-label', plan.replacement);
            if (node.hasAttribute('placeholder'))
              node.setAttribute('placeholder', plan.replacement);
            state.patches++;
          }
        }
      },
    };
    const observer = new MutationObserver(() => controller.apply());
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'aria-label',
        'aria-labelledby',
        'placeholder',
        'aria-hidden',
        'hidden',
        'inert',
        'class',
        'style',
      ],
    });
    (window as any).__reflexrunEvaluationDrift = state;
    controller.apply();
  }, plan);
}

export async function driftState(page: Page, plan: FaultPlan) {
  return {
    replacementCount: await page
      .getByRole(plan.target.role, { name: plan.replacement, exact: true })
      .count(),
    oldCount: plan.target.name
      ? await page.getByRole(plan.target.role, { name: plan.target.name, exact: true }).count()
      : await page
          .getByPlaceholder(plan.target.placeholder!, { exact: true })
          .filter({ visible: true })
          .count(),
    injection: await page.evaluate(() => (window as any).__reflexrunEvaluationDrift ?? null),
  };
}
export function verifiedDriftWitness(
  state: {
    replacementCount: number;
    oldCount: number;
    injection?: { patches: number; ambiguous: boolean };
  },
  previousPatches: number,
) {
  return (
    state.oldCount === 0 &&
    !state.injection?.ambiguous &&
    !!state.injection?.patches &&
    (state.replacementCount === 1 ||
      (state.replacementCount === 0 && state.injection.patches > previousPatches))
  );
}
export const mailpitInstruction = (input: Inputs, searchQuery = false) =>
  'The browser is open on a locally running upstream Mailpit application with test emails. Find the single email whose subject exactly matches ' +
  JSON.stringify(input.subject) +
  ', mark that email read, and add the tag ' +
  JSON.stringify(input.tag) +
  '. Keep existing tags, every other email, all message contents and attachments unchanged. Finish at the inbox so another email can be processed. ' +
  (searchQuery
    ? 'Use the subject as a search query rather than relying on the current list position. '
    : '') +
  'Discover the interface from the live browser; no action path is supplied. Do not use backend APIs, developer tools, evaluator files, source code or external resources. When finished, call task_complete with an exact literal UI completion condition; the host independently checks the original backend. If the response supplies nextInputs, perform that next task and call task_complete again, otherwise stop. Reuse snapshots already returned by native actions when sufficient.';

export async function benchmarkMailpit() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      upstream: { type: 'string' },
      out: { type: 'string' },
      rounds: { type: 'string', default: '4' },
      'settle-ms': { type: 'string', default: '500' },
      'no-video': { type: 'boolean' },
      method: { type: 'string' },
      'fault-plan': { type: 'string' },
      'search-query': { type: 'boolean' },
    },
  });
  assert.ok(values.binary && values.out, '--binary and a new --out directory are required');
  const rounds = Number(values.rounds),
    settleMs = parseSettleMs(values['settle-ms']!);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, '--rounds must be 1..20');
  assert.ok(
    !values.method || ['reflex', 'baseline'].includes(values.method),
    '--method must be reflex or baseline',
  );
  const directory = resolve(values.out);
  try {
    await access(directory);
    throw new Error('--out already exists; preserve prior evidence');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(directory, 'model-cwd'), { recursive: true });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', resolve(values.upstream!), ...args], { encoding: 'utf8' }).trim();
  const report: Record<string, any> = {
    schemaVersion: 1,
    started: stamp(),
    completed: false,
    application: {
      name: 'Mailpit',
      repository: 'https://github.com/axllent/mailpit',
      ...(values.upstream
        ? { commit: git('rev-parse', 'HEAD'), modifiedBefore: git('status', '--porcelain') }
        : {}),
    },
    protocol: {
      roundsRequested: rounds,
      order: 'Reflex-first then baseline-first, alternating',
      itemsPerActor: 7,
      phases: { cold: 1, normal: 3, changed: 3 },
      settleMs,
      searchQuery: !!values['search-query'],
      callbacks: 'serialized for both methods',
      verification:
        'exact backend summaries plus immutable raw-message hashes; target read and requested tag, all other messages unchanged',
      limits:
        'Official unmodified application and synthetic SMTP messages. The changed phase is a disclosed model-derived DOM label fault injection, not a natural upstream upgrade. A single application and a few paired trials do not establish arbitrary-site compatibility or universal speed.',
      timing:
        'Each phase starts when its queue is released and ends at the last independently confirmed business result. Batch/memory readiness and model completion are separate. Whole-job time includes model tails and inter-phase persistence, minus explicitly recorded evaluator pauses. Two hundred milliseconds of recording stabilization precedes phase transitions and is excluded equally.',
    },
    configuration: {
      viewport: { width: 1280, height: 900 },
      recordVideo: !values['no-video'],
      codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      playwrightMcp: JSON.parse(
        await readFile(join(root, 'node_modules/@playwright/mcp/package.json'), 'utf8'),
      ).version,
    },
    rounds: [],
    modelRuns: [],
    events: [],
  };
  let faultPlan: FaultPlan | undefined = values['fault-plan']
    ? JSON.parse(await readFile(resolve(values['fault-plan']), 'utf8'))
    : undefined;
  if (faultPlan) report.faultPlan = faultPlan;
  const save = () =>
    writeFile(join(directory, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
  const agent = (round: number, method: Method, phase: string) =>
    new CodexToolAgent({
      cwd: join(directory, 'model-cwd'),
      timeoutMs: 600_000,
      onEvent: (event) => {
        const row = { ...event, round, method, phase };
        report.events.push(row);
        appendFileSync(join(directory, 'model-events.jsonl'), JSON.stringify(row) + '\n');
        if (['model-start', 'tool-request', 'failed'].includes(event.type))
          process.stderr.write(
            'round ' +
              round +
              '/' +
              method +
              '/' +
              phase +
              ': ' +
              event.type +
              ' ' +
              (event.tool ?? event.model ?? event.error ?? '') +
              '\n',
          );
      },
    });
  await save();

  async function execute(round: number, method: Method, result: Record<string, any>) {
    const actor = 'round-' + round + '-' + method;
    const app = await MailpitEvaluation.start(values.binary!, join(directory, actor + '-app'));
    result.application = app.metadata;
    const inputs = app.inputs as Inputs[];
    result.inputs = inputs;
    result.readbacks = app.readbacks;
    result.initialState = await app.snapshot();
    let browser: LiveBrowser | undefined, proxy: ToolProxy | undefined;
    try {
      browser = await LiveBrowser.open(app.origin, actor, directory, {
        readerPath: false,
        pagePath: '/',
        viewport: report.configuration.viewport,
        settleMs,
        recordVideo: report.configuration.recordVideo,
        onPageCreated: (time) => {
          result.pageCreated = time;
        },
        onPointerClick: (click) => result.pointerClicks.push(click),
      });
      const page = browser.page;
      const native = browser.port.callTool.bind(browser.port);
      browser.port.callTool = async (call) => {
        const started = stamp();
        try {
          const response = await native(call);
          result.nativeCalls.push({ call, started, ended: stamp(), response });
          return response;
        } catch (error) {
          result.nativeCalls.push({ call, started, ended: stamp(), error: String(error) });
          throw error;
        }
      };
      const tools: ModelTool[] = [
        ...(await browser.tools(toolsOffered)).map(({ name, description, inputSchema }) => ({
          name,
          description: description ?? name,
          inputSchema,
        })),
        completeTool,
      ];
      result.tools = tools;
      result.toolsSha256 = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
      const cold: TaskTimeline = { started: stamp() };
      let lastConfirmed: ReturnType<typeof stamp> | undefined;
      let previousDriftPatches = 0;
      let currentPhase: Phase = 'cold';
      const verify = async (input: Inputs) => {
        assert.equal(
          new URL(page.url()).origin,
          app.origin,
          'Execution left its authorized application origin',
        );
        const outcome = await app.verify(input);
        const confirmed = stamp();
        if (currentPhase === 'changed') {
          assert.ok(faultPlan);
          const state = await driftState(page, faultPlan);
          result.driftChecks.push({ input, observed: stamp(), ...state });
          assert.ok(
            verifiedDriftWitness(state, previousDriftPatches),
            'No unambiguous persistent or newly mounted renamed-control witness for this item',
          );
          previousDriftPatches = state.injection.patches;
        }
        if (outcome.status === 'confirmed') lastConfirmed = confirmed;
        return outcome;
      };
      const pause = async (changed: boolean) => {
        const started = stamp();
        await sleep(200);
        if (changed) {
          assert.ok(faultPlan, 'No model-derived drift plan is available');
          await installDrift(page, faultPlan);
        }
        const ended = stamp();
        result.evaluatorPauses.push({
          started,
          ended,
          elapsedMs: ended.monotonicMs - started.monotonicMs,
          changed,
        });
      };
      result.executionStarted = cold.started;
      if (method === 'baseline') {
        let index = 0,
          phaseStarted = cold.started;
        const run = await agent(round, method, 'continuous-queue').run(
          mailpitInstruction(inputs[0], values['search-query']),
          tools,
          serialHandler(async (name, args) => {
            if (name !== 'task_complete')
              return [
                {
                  type: 'inputText',
                  text: plain(
                    await browser!.port.callTool({
                      name,
                      arguments: args as NativeCall['arguments'],
                    }),
                  ),
                },
              ];
            assert.ok(index < 7, 'The queue is already finished');
            const outcome =
              index === 0
                ? await confirmedReadback(cold, () => verify(inputs[index]))
                : await verify(inputs[index]);
            assert.equal(outcome.status, 'confirmed', JSON.stringify(outcome));
            result.rows.push({
              index,
              phase: phaseAt(index),
              input: inputs[index],
              confirmed: lastConfirmed,
              outcome,
              declaredGoal: args.goal,
            });
            index++;
            if ([1, 4, 7].includes(index)) {
              result.phases.push({
                phase: currentPhase,
                ...phaseTiming(phaseStarted, lastConfirmed),
                confirmed: currentPhase === 'cold' ? 1 : 3,
              });
              await save();
              if (index < 7) {
                await pause(index === 4);
                currentPhase = phaseAt(index);
                phaseStarted = stamp();
              }
            }
            return content({ outcome, nextInputs: inputs[index] ?? null, remaining: 7 - index });
          }),
        );
        cold.modelTurnReady = stamp();
        report.modelRuns.push({ ...run, round, method, phase: 'continuous-queue' });
        assert.equal(index, 7, 'Original model did not finish its queue');
        Object.assign(result.phases[0], summarizeTiming(cold));
      } else {
        const store = new ExperienceStore(join(directory, actor + '-memory'));
        proxy = new ToolProxy(browser.port, store, undefined, {
          onTiming: (event) => result.proxyTimings.push(event),
        });
        await proxy.host.initialize();
        const key = 'mailpit.tag-message';
        const first = await proxy.begin({
          key,
          job: 'cold',
          inputs: inputs[0],
          verification: 'readback',
          allowedScopes: [app.origin],
          readback: () => confirmedReadback(cold, () => verify(inputs[0])),
        });
        assert.equal(first.mode, 'explore');
        let completion: any, learning: Promise<MemoryResult | undefined> | undefined;
        const run = await agent(round, method, 'cold').run(
          mailpitInstruction(inputs[0], values['search-query']),
          tools,
          serialHandler(async (name, args) => {
            if (name !== 'task_complete')
              return [
                {
                  type: 'inputText',
                  text: plain(
                    await proxy!.call({ name, arguments: args as NativeCall['arguments'] }),
                  ),
                },
              ];
            completion = await proxy!.finish(args.goal as Check);
            result.coldCompletion = completion;
            if (completion.mode === 'done')
              learning = proxy!.waitForLearning().then((learned) => {
                if (learned?.learning === 'ready') cold.memoryReady = stamp();
                return learned;
              });
            return content({ ...completion, nextInputs: null, remaining: 0 });
          }),
        );
        cold.modelTurnReady = stamp();
        report.modelRuns.push({ ...run, round, method, phase: 'cold' });
        assert.equal(completion?.result?.status, 'completed', JSON.stringify(completion));
        assert.ok(learning);
        const learned = await learning;
        assert.equal(learned?.learning, 'ready', learned?.learningError ?? JSON.stringify(learned));
        result.memoryAfterCold = await store.list();
        assert.equal(result.memoryAfterCold.length, 1);
        result.rows.push({
          index: 0,
          phase: 'cold',
          input: inputs[0],
          confirmed: cold.taskReady,
          result: learned,
        });
        result.phases.push({
          phase: 'cold',
          ...phaseTiming(cold.started, lastConfirmed),
          ...summarizeTiming(cold),
          localTimings: learned?.timings,
          confirmed: 1,
        });
        await save();
        let repairs = 0;
        const runner = new Reflex({
          host: proxy.host,
          store,
          repair: async (context) => {
            repairs++;
            const patch: Record<string, any> = {
              started: stamp(),
              failed: context.failed,
              status: 'requested',
              proposals: [],
            };
            result.repairs.push(patch);
            try {
              const original = tools.find((tool) => tool.name === context.failed.tool);
              assert.ok(original);
              const proposal: ModelTool = {
                name: 'submit_patch',
                description:
                  'Propose only a replacement target for the failed original native action. Do not execute a write.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    calls: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 1,
                      items: {
                        type: 'object',
                        properties: {
                          name: { const: original.name },
                          arguments: original.inputSchema,
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
              let translated: Action[] | undefined;
              const repaired = await agent(round, method, 'repair').runUntilTool(
                'A learned action no longer resolves before dispatch. From the supplied current snapshot, propose submit_patch under the original tool schema. Change only target refs and their descriptive element text; keep all content, key, submit, button and modifier payloads unchanged. Do not execute writes. Inputs: ' +
                  JSON.stringify(context.task.inputs) +
                  '. Failed call: ' +
                  JSON.stringify({ name: context.failed.tool, arguments: context.failed.args }) +
                  '. Current snapshot: ' +
                  context.observation.text,
                [tools.find((tool) => tool.name === 'browser_snapshot')!, proposal],
                serialHandler(async (name, args) => {
                  if (name !== 'submit_patch')
                    return [
                      {
                        type: 'inputText',
                        text: plain(
                          await browser!.port.callTool({
                            name,
                            arguments: args as NativeCall['arguments'],
                          }),
                        ),
                      },
                    ];
                  const attempt: Record<string, any> = {
                    received: stamp(),
                    calls: structuredClone(args.calls),
                    status: 'received',
                  };
                  patch.proposals.push(attempt);
                  try {
                    const calls = args.calls as NativeCall[];
                    assert.equal(calls.length, 1);
                    assert.ok(
                      targetOnlyNativePatch(
                        { name: context.failed.tool!, arguments: context.failed.args! },
                        calls[0],
                        Object.keys(context.failed.bindings ?? {}),
                      ),
                      'Repair changed behavior or non-target payload',
                    );
                    translated = await Promise.all(
                      calls.map((call) => proxy!.host.translate(call)),
                    );
                    patch.ready = stamp();
                    patch.calls = calls;
                    attempt.status = 'accepted';
                    return content({ received: true });
                  } catch (error) {
                    attempt.status = 'rejected';
                    attempt.error = error instanceof Error ? error.stack : String(error);
                    throw error;
                  }
                }),
                'submit_patch',
              );
              report.modelRuns.push({ ...repaired, round, method, phase: 'repair' });
              patch.modelTimings = repaired.timings;
              assert.ok(translated?.length);
              patch.status = 'accepted';
              return translated;
            } catch (error) {
              patch.status = 'failed';
              patch.error = error instanceof Error ? error.stack : String(error);
              throw error;
            } finally {
              patch.ended = stamp();
            }
          },
        });
        const items = inputs.slice(1).map((input, index) => ({
          id: 'item-' + (index + 1),
          label: String(input.subject),
          inputs: input,
          facts: {},
        }));
        for (const phase of ['normal', 'changed'] as const) {
          // Do not suppress a normal replay failure just because no fault plan is yet available.
          if (phase === 'changed' && !faultPlan) {
            faultPlan = deriveFaultPlan(result.memoryAfterCold[0]);
            report.faultPlan = faultPlan;
          }
          await pause(phase === 'changed');
          currentPhase = phase;
          const started = stamp(),
            previousRepairs = repairs;
          const batch = await runMemoryBatch(runner, {
            id: actor + '-six',
            operation: key,
            policy: () => ({ revision: 1, rules: [] }),
            verification: 'readback',
            allowedScopes: [app.origin],
            timeoutMs: 360_000,
            items: phase === 'normal' ? items.slice(0, 3) : items,
            readback: (item) => verify(item.inputs),
            onItem: (row, itemResult) => {
              result.rows.push({ ...row, phase, observed: stamp(), result: itemResult });
            },
          });
          const batchReady = stamp();
          result.phases.push({
            phase,
            ...phaseTiming(started, lastConfirmed, batchReady),
            confirmed:
              app.readbacks.filter((row) => row.outcome.status === 'confirmed').length -
              (phase === 'normal' ? 1 : 4),
            repairs: repairs - previousRepairs,
            batch,
          });
          await save();
          assert.ok(
            batch.rows.every((row) => row.status === 'confirmed'),
            JSON.stringify(batch),
          );
          assert.equal(
            repairs - previousRepairs,
            phase === 'changed' ? 1 : 0,
            'Unexpected repair count; preserve this real integration failure',
          );
        }
        result.memories = await store.list();
      }
      result.finalState = await app.snapshot();
      result.readbacks = app.readbacks;
      assert.equal(app.readbacks.filter((row) => row.outcome.status === 'confirmed').length, 7);
      assert.ok(lastConfirmed);
      const evaluatorMs = result.evaluatorPauses.reduce(
        (sum: number, pause: any) => sum + pause.elapsedMs,
        0,
      );
      result.jobBusinessReady = lastConfirmed;
      result.jobBusinessReadyMs =
        lastConfirmed.monotonicMs - cold.started.monotonicMs - evaluatorMs;
      result.evaluatorMs = evaluatorMs;
      result.completed = true;
    } finally {
      result.readbacks = app.readbacks;
      try {
        result.finalState = await app.snapshot();
      } catch (error) {
        result.finalStateError = String(error);
      }
      await proxy?.cancel();
      if (browser) {
        const video = browser.page.video();
        result.browserClosing = stamp();
        await browser.close();
        result.browserClosed = stamp();
        if (video) {
          result.rawVideo = join(directory, actor + '.webm');
          await copyFile(await video.path(), result.rawVideo);
        }
      }
      await app.close();
      await save();
    }
  }

  try {
    for (let round = 1; round <= rounds; round++) {
      const order: Method[] = values.method
        ? [values.method as Method]
        : round % 2
          ? ['reflex', 'baseline']
          : ['baseline', 'reflex'];
      const row: Record<string, any> = { round, order, results: {} };
      report.rounds.push(row);
      for (const method of order) {
        const result: Record<string, any> = {
          completed: false,
          rows: [],
          phases: [],
          nativeCalls: [],
          pointerClicks: [],
          readbacks: [],
          evaluatorPauses: [],
          driftChecks: [],
          proxyTimings: [],
          repairs: [],
        };
        row.results[method] = result;
        await execute(round, method, result);
      }
      if (!values.method)
        assert.equal(
          row.results.baseline.toolsSha256,
          row.results.reflex.toolsSha256,
          'The original tool schemas differ',
        );
    }
    assert.equal(
      new Set(
        report.modelRuns.map((run: any) =>
          JSON.stringify([run.model, run.provider, run.reasoningEffort]),
        ),
      ).size,
      1,
      'Model configuration changed across methods or rounds',
    );
    if (values.upstream) {
      report.application.modifiedAfter = git('status', '--porcelain');
      assert.equal(report.application.modifiedBefore, '', 'Upstream source was already modified');
      assert.equal(report.application.modifiedAfter, '', 'Upstream source changed');
    }
    report.completed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    report.ended = stamp();
    await save();
    process.stderr.write(
      'Saved private evidence: ' + directory + '\nCompleted: ' + report.completed + '\n',
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await benchmarkMailpit();

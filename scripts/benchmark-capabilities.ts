import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodexToolAgent,
  type ModelContent,
  type ModelEvent,
  type ModelTool,
} from '../src/model/codex.js';
import { ExperienceStore, type StepAtomRef } from '../src/memory/store.js';
import { decode, setAt } from '../src/memory/compiler.js';
import {
  CapabilityLibrary,
  CapabilityCapture,
  type CapabilityProposal,
  type FactRule,
  type FactState,
} from '../src/memory/capabilities.js';
import type { Action, Check, Inputs, Json, Task } from '../src/memory/types.js';
import type { NativeCall } from '../src/proxy/index.js';
import { PlaywrightMcpHost } from '../src/proxy/playwright.js';
import { LiveBrowser, completeTool, parseSettleMs, plain } from './live-runtime.js';
import { driftState, installDrift, serialHandler, type FaultPlan } from './benchmark-mailpit.js';
import { MailpitEvaluation, type MailpitSnapshot } from './mailpit-evaluation.js';
import { stamp } from './showcase-timing.js';

const content = (value: unknown): ModelContent[] => [
  { type: 'inputText', text: JSON.stringify(value) },
];
const rules = (read: boolean, tag?: string): FactRule[] => [
  ...(read ? [{ field: 'Read', op: 'equals' as const, value: true }] : []),
  ...(tag ? [{ field: 'Tags', op: 'contains' as const, value: { $input: 'tag' } }] : []),
];
const source = 'Official Mailpit summaries and raw-message SHA256, read without opening messages';
const recordKind = 'mail-message';
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

function modelCounts(events: ModelEvent[]) {
  const requests = events.filter((event) => event.type === 'tool-request');
  return {
    modelTurns: events.filter((event) => event.type === 'turn-request').length,
    modelToolCalls: requests.length,
    modelBrowserCalls: requests.filter((event) => String(event.tool).startsWith('browser_')).length,
    planRequests: requests.filter((event) => event.tool === 'select_capabilities').length,
    repairRequests: requests.filter((event) => event.tool === 'submit_patch').length,
    proposalRequests: requests.filter(
      (event) =>
        event.tool === 'task_complete' &&
        Array.isArray((event.arguments as { proposals?: unknown } | undefined)?.proposals),
    ).length,
  };
}

function pairedState(snapshot: MailpitSnapshot) {
  return snapshot.messages
    .map(({ ID: _mailpitId, rawSha256: _smtpEnvelopeHash, ...message }) => message)
    .sort((left, right) => left.Subject.localeCompare(right.Subject));
}

/** A trusted host reader, deliberately separate from model/tool execution. */
export function mailFacts(snapshot: MailpitSnapshot, scope: string, subject: string): FactState {
  const targets = snapshot.messages.filter((message) => message.Subject === subject);
  assert.equal(targets.length, 1, 'The requested subject must identify one original record');
  const records = Object.fromEntries(
    snapshot.messages.map((message) => [message.ID, json(message)]),
  );
  return {
    scope,
    recordKind,
    identity: targets[0].ID,
    fields: records[targets[0].ID] as Record<string, Json>,
    records: records as Record<string, Record<string, Json>>,
    writableFields: ['Read', 'Tags'],
    source,
  };
}

/** Exact expected state, including all unrelated records and immutable message bytes. */
export function expectedMailGoal(before: MailpitSnapshot, input: Inputs, goal: FactRule[]) {
  const expected = structuredClone(before);
  const targets = expected.messages.filter((message) => message.Subject === input.subject);
  assert.equal(targets.length, 1);
  for (const rule of goal) {
    const value = decode(rule.value, input);
    if (rule.field === 'Read' && rule.op === 'equals' && value === true) targets[0].Read = true;
    else if (rule.field === 'Tags' && rule.op === 'contains' && typeof value === 'string')
      targets[0].Tags = [...new Set([...targets[0].Tags, value])].sort();
    else throw new Error('Evaluator only authorizes marking read and adding the requested tag');
  }
  return expected;
}

async function sharedStepRefs(
  directory: string,
  sources: { key: string; sourceExperience: { id: string } }[],
  used: string[],
) {
  const workflows = Object.fromEntries(
    await Promise.all(
      sources.map(async ({ key, sourceExperience }) => {
        const workflow = JSON.parse(
          await readFile(join(directory, 'experiences', sourceExperience.id + '.json'), 'utf8'),
        ) as { format: number; steps: StepAtomRef[] };
        assert.equal(workflow.format, 3);
        return [key, workflow.steps.map(({ atom }) => atom)] as const;
      }),
    ),
  );
  const catalog = JSON.parse(await readFile(join(directory, 'capabilities.json'), 'utf8')) as {
    format: number;
    capabilities: { id: string; atoms: StepAtomRef[] }[];
  };
  assert.equal(catalog.format, 2);
  const byId = new Map(
    catalog.capabilities.map(({ id, atoms }) => [id, atoms.map(({ atom }) => atom)]),
  );
  const savedPrograms = new Set(
    (await readdir(join(directory, 'atoms')))
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .map((file) => file.slice(0, -5)),
  );
  for (const atom of [...Object.values(workflows), ...byId.values()].flat())
    assert.ok(savedPrograms.has(atom), 'A stored step reference has no physical program');
  return {
    storedPrograms: savedPrograms.size,
    workflows,
    usedCapabilities: used.map((id) => {
      const atoms = byId.get(id);
      assert.ok(atoms, 'A step used by C is missing from the saved catalog');
      return { id, atoms };
    }),
  };
}

export async function benchmarkCapabilities() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      out: { type: 'string' },
      rounds: { type: 'string', default: '3' },
      paired: { type: 'boolean' },
      auto: { type: 'boolean' },
      'settle-ms': { type: 'string', default: '500' },
      'no-video': { type: 'boolean' },
    },
  });
  assert.ok(values.binary && values.out, '--binary and a new --out directory are required');
  const rounds = Number(values.rounds),
    settleMs = parseSettleMs(values['settle-ms']!),
    paired = values.paired === true,
    automatic = values.auto === true;
  assert.ok(!automatic || paired, '--auto requires --paired first-C conditions');
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
  const directory = resolve(values.out);
  try {
    await access(directory);
    throw new Error('--out already exists; preserve prior evidence');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(directory, 'model-cwd'), { recursive: true });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sourceFiles = [
    ...(await readdir(join(root, 'src'), { recursive: true }))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => 'src/' + name),
    'scripts/benchmark-capabilities.ts',
    'scripts/benchmark-mailpit.ts',
    'scripts/mailpit-evaluation.ts',
    'scripts/live-runtime.ts',
    'scripts/showcase-timing.ts',
    'package.json',
    'package-lock.json',
  ].sort();
  const hashes = async () =>
    Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (name) => [
          name,
          createHash('sha256')
            .update(await readFile(join(root, name)))
            .digest('hex'),
        ]),
      ),
    );
  const sourceHashes = await hashes();
  const report: Record<string, any> = {
    schemaVersion: paired ? 3 : 1,
    started: stamp(),
    completed: false,
    configuration: {
      node: process.version,
      codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      playwright: JSON.parse(
        await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8'),
      ).version,
      playwrightMcp: JSON.parse(
        await readFile(join(root, 'node_modules/@playwright/mcp/package.json'), 'utf8'),
      ).version,
      sourceHashes,
    },
    protocol: {
      application: 'Official Mailpit binary; SMTP synthetic mail; no site action script',
      model: 'Original Codex gpt-6.1-terra / low; native Playwright MCP tools',
      settleMs,
      learning: automatic
        ? 'Automatic runtime induction from verified typed task goals and trusted before/after state. No model-supplied ranges.'
        : 'The original model names reusable source ranges with completion of A and B in the same turn. The host derives effects and route guards from trusted before/after observations. Admission checks UI, record identity, field deltas and every other record.',
      composition: automatic
        ? 'For unseen C, the library must match compatible learned steps to typed goals locally. No model planning fallback is configured.'
        : 'For unseen C, the library first matches compatible learned steps to typed goals locally. It requests a model plan only if it cannot select uniquely.',
      state: paired
        ? 'First C is a different email with neither outcome satisfied. Setup-only API writes are outside task clocks.'
        : 'Four C inputs: unread/no tag, read/no tag, unread/tag, read/tag. Setup-only API writes are outside task clocks.',
      ...(!paired
        ? {
            repair:
              'One controlled shared input-label perturbation derived from actual common learned bindings, not a natural upstream update.',
          }
        : {}),
      verification:
        'Every task: exact full mailbox state plus raw-message hashes. Unknown state stops. No model business API access.',
      timing:
        'Queue release through independent exact backend confirmation. Learning/selection and persistence are recorded separately; no timing advantage inferred from fixtures.',
      ...(paired
        ? {
            pairing:
              'Alternate ReflexRun-first and original-first. Fresh mailboxes, matching SMTP data and business goals, same settle and native tools. Each model turn starts in a fresh ephemeral Codex thread. ' +
              (automatic
                ? 'Both arms use identical model instructions and task completion tools for A/B.'
                : 'ReflexRun A/B additionally submit same-turn source ranges.') +
              ' Both C clocks include planning and any model startup, then stop after exact backend confirmation and return to inbox.',
            modelMetrics:
              'Counts are observed turn/start events and tool submissions. One Codex turn can include several provider responses. Raw usage is retained as telemetry.',
          }
        : {}),
    },
    rounds: [],
    modelRuns: [],
    events: [],
  };
  const save = () =>
    writeFile(join(directory, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
  const agent = (round: number, method: 'baseline' | 'reflex', stage: string) =>
    new CodexToolAgent({
      cwd: join(directory, 'model-cwd'),
      timeoutMs: 300_000,
      onEvent: (event) => {
        const row = { ...event, round, method, stage };
        report.events.push(row);
        appendFileSync(join(directory, 'model-events.jsonl'), JSON.stringify(row) + '\n');
        if (['model-start', 'tool-request', 'tool-error', 'failed'].includes(event.type))
          process.stderr.write(
            `${round}/${method}/${stage}: ${event.type} ${event.tool ?? event.error ?? ''}\n`,
          );
      },
    });
  await save();
  const runActor = async (
    round: number,
    method: 'baseline' | 'reflex',
    row: Record<string, any>,
  ) => {
    const actor = paired ? `capabilities-${round}-${method}` : `capabilities-${round}`;
    Object.assign(row, {
      round,
      method,
      tasks: [],
      learning: [],
      plans: [],
      repairs: [],
      nativeCalls: [],
      pointerClicks: [],
      factReads: [],
      readbacks: [],
      completed: false,
    });
    const app = await MailpitEvaluation.start(values.binary!, join(directory, actor + '-app'));
    row.application = app.metadata;
    let browser: LiveBrowser | undefined;
    try {
      const seeded = await app.snapshot();
      const id = (index: number) =>
        seeded.messages.find((message) => message.Subject === app.inputs[index].subject)!.ID;
      const put = async (path: string, payload: unknown) => {
        const response = await fetch(app.origin + path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.ok(response.ok, `Fixture preparation failed: ${response.status}`);
        (row.setupWrites ??= []).push({ path, payload, at: stamp() });
      };
      await put('/api/v1/messages', { IDs: [id(2), id(4), id(6)], Read: true });
      for (const index of [3, 4])
        await put('/api/v1/tags', { IDs: [id(index)], Tags: [app.inputs[index].tag] });
      row.initialState = await app.snapshot();
      browser = await LiveBrowser.open(app.origin, actor, directory, {
        readerPath: false,
        pagePath: '/',
        settleMs,
        recordVideo: !values['no-video'],
        viewport: { width: 1280, height: 900 },
        onPageCreated: (at) => {
          row.pageCreated = at;
        },
        onPointerClick: (click) => row.pointerClicks.push(click),
      });
      const native = browser.port.callTool.bind(browser.port);
      browser.port.callTool = async (call) => {
        const started = stamp();
        try {
          const response = await native(call);
          row.nativeCalls.push({ call, started, ended: stamp(), response });
          return response;
        } catch (error) {
          row.nativeCalls.push({ call, started, ended: stamp(), error: String(error) });
          throw error;
        }
      };
      const host = new PlaywrightMcpHost(browser.port);
      if (method === 'reflex') await host.initialize();
      const store = new ExperienceStore(join(directory, actor + '-memory'));
      const library = new CapabilityLibrary(
        automatic ? store.directory : join(directory, actor + '-capabilities'),
      );
      const tools: ModelTool[] = [
        ...(
          await browser.tools([
            'browser_snapshot',
            'browser_type',
            'browser_press_key',
            'browser_click',
            'browser_navigate_back',
            'browser_fill_form',
            'browser_select_option',
          ])
        ).map(({ name, description, inputSchema }) => ({
          name,
          description: description ?? name,
          inputSchema,
        })),
        completeTool,
      ];
      row.tools = tools;
      row.toolsSha256 = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
      const readFacts = async (input: Inputs) => {
        const started = stamp();
        const facts = mailFacts(await app.snapshot(), app.origin, String(input.subject));
        row.factReads.push({
          started,
          ended: stamp(),
          identity: facts.identity,
          fields: facts.fields,
        });
        return facts;
      };
      const task = async (key: string, input: Inputs, goal: FactRule[]) => {
        const before = await app.snapshot(),
          expected = expectedMailGoal(before, input, goal);
        const entry: Record<string, any> = { key, input, goal, before, started: stamp() };
        row.tasks.push(entry);
        const verify = async () => {
          const started = stamp(),
            after = await app.snapshot();
          const returned = browser!.page.url() === browser!.url;
          const outcome = {
            status:
              returned && isDeepStrictEqual(after, expected)
                ? ('confirmed' as const)
                : ('rejected' as const),
            source,
          };
          row.readbacks.push({
            key,
            input,
            started,
            observed: stamp(),
            before,
            after,
            expected,
            returned,
            outcome,
          });
          if (outcome.status === 'confirmed') {
            entry.confirmed ??= stamp();
            entry.businessReadyMs = entry.confirmed.monotonicMs - entry.started.monotonicMs;
          }
          return outcome;
        };
        const definition: Task = {
          key,
          job: `round-${round}-${row.tasks.length}`,
          inputs: input,
          verification: 'readback',
          allowedScopes: [app.origin],
          readback: verify,
        };
        return { entry, definition, verify };
      };
      const instructionForTask = (input: Inputs, instruction: string) =>
        `The live browser is an official Mailpit test mailbox. ${instruction} The exact subject is ${JSON.stringify(input.subject)}${input.tag ? ` and target tag is ${JSON.stringify(input.tag)}` : ''}. Use the subject as a search query rather than relying on current list position. Preserve existing tags, all other emails and every raw message byte. Finish at the inbox with the search cleared, ready for another task. Discover the interface with the supplied native tools; no action path is supplied. Do not use backend APIs, source code, files or external resources. Call task_complete when visibly done.`;
      const aInput = { subject: app.inputs[0].subject };
      const bInput = app.inputs[0] as Inputs;
      const cInput = app.inputs[1] as Inputs;
      const aInstruction = 'Find the specified email and mark it read.';
      const bInstruction = 'Find the specified already-read email and add only the requested tag.';
      const cInstruction = 'Find the specified email, mark it read and add the requested tag.';
      const recordPairResult = (current: Awaited<ReturnType<typeof task>>) => {
        const started = current.entry.started.monotonicMs;
        const confirmed = current.entry.confirmed.monotonicMs;
        const firstStarted = row.tasks[0].started.monotonicMs;
        const inTask = (time: number) => time >= started && time <= confirmed;
        const allEvents = report.events.filter(
          (event: ModelEvent) =>
            event.round === round &&
            event.method === method &&
            Number(event.monotonicMs) >= firstStarted &&
            Number(event.monotonicMs) <= confirmed,
        );
        const events = allEvents.filter((event: ModelEvent) => inTask(Number(event.monotonicMs)));
        const nativeCalls = row.nativeCalls.filter((call: any) => inTask(call.started.monotonicMs));
        const allNativeCalls = row.nativeCalls.filter(
          (call: any) =>
            call.started.monotonicMs >= firstStarted && call.started.monotonicMs <= confirmed,
        );
        const browserSnapshots = (calls: typeof nativeCalls) =>
          calls.filter(({ call }: { call: NativeCall }) => call.name === 'browser_snapshot').length;
        row.comparison = {
          started: current.entry.started,
          confirmed: current.entry.confirmed,
          businessReadyMs: current.entry.businessReadyMs,
          ...modelCounts(events),
          browserCalls: nativeCalls.length,
          browserSnapshots: browserSnapshots(nativeCalls),
          browserActions: nativeCalls.filter(
            ({ call }: { call: NativeCall }) => call.name !== 'browser_snapshot',
          ).length,
          modelUsage: events
            .filter((event: ModelEvent) => event.type === 'usage')
            .map((event: ModelEvent) => event.usage),
          learningTurns: modelCounts(allEvents).modelTurns - modelCounts(events).modelTurns,
          learningWallMs: started - firstStarted,
          throughFirstC: {
            elapsedMs: confirmed - firstStarted,
            ...modelCounts(allEvents),
            browserCalls: allNativeCalls.length,
            browserSnapshots: browserSnapshots(allNativeCalls),
          },
          startingMailbox: pairedState(current.entry.before),
        };
      };
      if (method === 'baseline') {
        const runTask = async (
          key: string,
          input: Inputs,
          goal: FactRule[],
          instruction: string,
        ) => {
          const current = await task(key, input, goal);
          const run = await agent(round, method, key).runUntilTool(
            instructionForTask(input, instruction),
            tools,
            serialHandler(async (name, args) => {
              if (name === 'task_complete') {
                assert.equal((await current.verify()).status, 'confirmed');
                return content({ confirmed: true, nextInputs: null });
              }
              const response = await browser!.port.callTool({
                name,
                arguments: args as NativeCall['arguments'],
              });
              return [{ type: 'inputText', text: plain(response) }];
            }),
            'task_complete',
          );
          report.modelRuns.push({ round, method, stage: key, ...run });
          assert.ok(current.entry.confirmed, 'Original model must complete exact verification');
          return current;
        };
        await runTask('A.read', aInput, rules(true), aInstruction);
        await runTask('B.tag', bInput, rules(false, String(bInput.tag)), bInstruction);
        const novel = await runTask(
          'C.state-1',
          cInput,
          rules(true, String(cInput.tag)),
          cInstruction,
        );
        recordPairResult(novel);
        row.finalState = await app.snapshot();
        row.completed = true;
        return;
      }
      const completionSchema = completeTool.inputSchema as {
        properties: Record<string, unknown>;
      };
      const trainingCompletion: ModelTool = {
        ...completeTool,
        description: completeTool.description + ' Include reusable fragments from this turn.',
        inputSchema: {
          type: 'object',
          properties: {
            ...completionSchema.properties,
            proposals: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  start: { type: 'integer', minimum: 0 },
                  end: { type: 'integer', minimum: 1 },
                },
                required: ['label', 'start', 'end'],
                additionalProperties: false,
              },
            },
          },
          required: ['goal', 'proposals'],
          additionalProperties: false,
        },
      };
      const trainingTools = automatic ? tools : [...tools.slice(0, -1), trainingCompletion];
      row.trainingToolsSha256 = createHash('sha256')
        .update(JSON.stringify(trainingTools))
        .digest('hex');
      const learn = async (key: string, input: Inputs, goal: FactRule[], instruction: string) => {
        const current = await task(key, input, goal);
        const capture = new CapabilityCapture({
          host,
          store,
          task: current.definition,
          library,
          readFacts: () => readFacts(input),
          ...(automatic ? { goal } : {}),
        });
        const learning: Record<string, any> = { key, started: stamp() };
        if (!automatic) learning.proposals = [];
        row.learning.push(learning);
        current.entry.trace = capture.trace;
        await capture.observe();
        let memory: Awaited<ReturnType<CapabilityCapture['complete']>> | undefined;
        let admitted: Awaited<ReturnType<CapabilityCapture['waitForCapabilities']>> | undefined;
        let learningError: string | undefined;
        const rangeInstruction = automatic
          ? ''
          : ' In the same task_complete call, name disjoint, contiguous reusable ranges [start,end) using the captured source step numbers. Cover the successful route from inbox through the task and back. Skip failed steps and detours. Separate navigation to the record, different field effects, and navigation away where reusable. Keep the actions necessary for each effect together. The host derives effects and route checks from its own before/after observations. If a range is rejected after completion, retry task_complete with corrected ranges. Do not perform more actions after completion.';
        const run = await agent(round, method, key).runUntilTool(
          instructionForTask(input, instruction) + rangeInstruction,
          trainingTools,
          serialHandler(async (name, args) => {
            if (name === 'task_complete') {
              if (automatic) {
                memory = await capture.complete(args.goal as Check);
                current.entry.sourceExperience = memory;
                try {
                  admitted = await capture.waitForCapabilities();
                  current.entry.memoryReady = stamp();
                } catch (error) {
                  learningError = error instanceof Error ? error.message : String(error);
                }
                return content({ confirmed: true, nextInputs: null });
              }
              const ranges = args.proposals as Pick<
                CapabilityProposal,
                'label' | 'start' | 'end'
              >[];
              const attempt: Record<string, any> = { at: stamp(), value: ranges };
              learning.proposals.push(attempt);
              try {
                const holds = (facts: FactState, rule: FactRule) => {
                  const actual = facts.fields[rule.field],
                    expected = decode(rule.value, input);
                  return rule.op === 'contains'
                    ? Array.isArray(actual) &&
                        actual.some((value) => isDeepStrictEqual(value, expected))
                    : isDeepStrictEqual(actual, expected);
                };
                const proposals = ranges.map(({ label, start, end }) => {
                  const before = capture.boundaryAt(start),
                    after = capture.boundaryAt(end - 1, 'after');
                  assert.ok(
                    before?.observation.url && after?.observation.url,
                    'Missing captured boundary URL',
                  );
                  return {
                    label,
                    start,
                    end,
                    requires: { urlIncludes: new URL(before.observation.url).origin },
                    ensures: { urlIncludes: new URL(after.observation.url).origin },
                    effects: goal.filter(
                      (rule) => !holds(before.facts, rule) && holds(after.facts, rule),
                    ),
                  };
                });
                attempt.derived = proposals;
                memory ??= await capture.complete(args.goal as Check);
                current.entry.sourceExperience = memory;
                admitted = await capture.submitCapabilities(proposals);
                current.entry.memoryReady = stamp();
                return content({ confirmed: true, nextInputs: null });
              } catch (error) {
                attempt.error = String(error);
                throw error;
              }
            }
            const call = { name, arguments: args as NativeCall['arguments'] };
            if (host.isReadOnly(call))
              return [{ type: 'inputText', text: plain(await host.forward(call)) }];
            assert.ok(
              !memory,
              automatic
                ? 'The verified task is closed'
                : 'The verified task is closed; retry only the source proposals',
            );
            const action = await host.translate(call);
            const index = capture.trace.length,
              nativeIndex = row.nativeCalls.length;
            await capture.act(action);
            // Both model arms receive the same native action reply format. Capture-only
            // observations remain local and are separately counted as browser calls.
            const response = row.nativeCalls
              .slice(nativeIndex)
              .find((entry: { call: NativeCall }) => entry.call.name === name)?.response;
            assert.ok(response, 'The captured action had no native browser response');
            if (automatic) return [{ type: 'inputText', text: plain(response) }];
            const boundary = (side: 'before' | 'after') => {
              const entry =
                side === 'before' ? capture.boundaryAt(index) : capture.boundaryAt(index, 'after');
              if (!entry) return null;
              const { url } = entry.observation;
              const address = url ? new URL(url) : undefined;
              return {
                path: address ? address.pathname + address.search : undefined,
                fields: { Read: entry.facts.fields.Read, Tags: entry.facts.fields.Tags },
              };
            };
            return [
              {
                type: 'inputText',
                text:
                  plain(response) +
                  '\nCaptured source step ' +
                  index +
                  ': ' +
                  JSON.stringify({ before: boundary('before'), after: boundary('after') }),
              },
            ];
          }),
          'task_complete',
        );
        report.modelRuns.push({ round, method, stage: key, ...run });
        Object.assign(learning, {
          admitted,
          error: learningError,
          persisted: stamp(),
          status: capture.learning,
        });
        await save();
        assert.ok(
          memory && admitted?.length,
          learningError ??
            (automatic
              ? 'Verified task had no automatic capabilities'
              : 'Original agent did not submit verified capabilities'),
        );
        return admitted;
      };
      const a = await learn('A.read', aInput, rules(true), aInstruction);
      const b = await learn('B.tag', bInput, rules(false, String(bInput.tag)), bInstruction);
      const novel = paired
        ? await task('C.state-1', cInput, rules(true, String(cInput.tag)))
        : undefined;
      const selection: ModelTool = {
        name: 'select_capabilities',
        description:
          'Select an ordered program using existing capability IDs only. No new actions can be supplied.',
        inputSchema: {
          type: 'object',
          properties: { plan: { type: 'array', minItems: 1, items: { type: 'string' } } },
          required: ['plan'],
          additionalProperties: false,
        },
      };
      const learned = await library.candidates(app.origin, recordKind);
      const contributes = (ids: string[], sourceIndex: number, field: string) =>
        learned.some(
          (cap) =>
            ids.includes(cap.id) &&
            cap.evidence.some(
              (item) => item.experience === row.tasks[sourceIndex].sourceExperience.id,
            ) &&
            cap.stepEffects.some((rules) => rules.some((rule) => rule.field === field)),
        );
      const selectPlan: NonNullable<Parameters<CapabilityLibrary['run']>[0]['selectPlan']> = async (
        candidates,
        initial,
      ) => {
        let selected: string[] | undefined;
        const planRun = await agent(round, method, 'C-plan').runUntilTool(
          'Call select_capabilities with {"plan":["<first capability ID>","<next capability ID>"]} to submit an ordered program for a new task. Search for the specified email, make Read=true and add input.tag while preserving other tags, then return to the inbox with search cleared. Compose the smallest correct program from the catalog only; do not explore or invent new actions. Use A-source Read and B-source Tags effects. Share a common open/find path when possible. Join each outcomeContext to the next contexts[0]. Inputs: ' +
            JSON.stringify(cInput) +
            '. Current route: ' +
            initial.observation.url +
            '. Catalog: ' +
            JSON.stringify(candidates),
          [selection],
          serialHandler(async (_name, args) => {
            const plan = args.plan as string[];
            const parts = plan.map((id) => candidates.find((cap) => cap.id === id));
            assert.ok(
              parts.every((part) => part !== undefined) &&
                contributes(plan, 0, 'Read') &&
                contributes(plan, 1, 'Tags') &&
                parts.every(
                  (part, i) => i === 0 || parts[i - 1]?.outcomeContext === part?.contexts[0],
                ),
              'Compose a route-compatible program with admitted A-source Read and B-source Tags effects',
            );
            selected = plan;
            return content({ selected });
          }),
          'select_capabilities',
        );
        report.modelRuns.push({ round, method, stage: 'C-plan', ...planRun });
        assert.ok(selected?.length);
        return selected;
      };
      let c: string[] | undefined;
      const execute = async (
        key: string,
        input: Inputs,
        goal: FactRule[],
        plan?: string[],
        repair?: Parameters<CapabilityLibrary['run']>[0]['repair'],
      ) => {
        const current = (key === 'C.state-1' && novel) || (await task(key, input, goal)),
          { identity } = mailFacts(current.entry.before, app.origin, String(input.subject));
        const result = await library.run({
          task: current.definition,
          identity,
          recordKind,
          goal,
          plan,
          selectPlan: automatic || plan ? undefined : selectPlan,
          host,
          readFacts: () => readFacts(input),
          repair,
        });
        current.entry.result = result;
        current.entry.plan = result.plan;
        current.entry.finished = stamp();
        assert.equal(result.status, 'completed', `${key}: ${result.error ?? result.status}`);
        if (!paired) assert.equal((await current.verify()).status, 'confirmed');
        await save();
        return result;
      };
      const stateResults = [];
      for (let index = 1; index <= (paired ? 1 : 4); index++) {
        const result = await execute(
          `C.state-${index}`,
          app.inputs[index] as Inputs,
          rules(true, app.inputs[index].tag),
          c,
        );
        c ??= result.plan;
        stateResults.push(result);
      }
      assert.ok(c?.length);
      row.plans.push({
        task: 'C',
        started: row.tasks[2].started,
        plan: c,
        source: stateResults[0].planSource,
      });
      assert.ok(
        contributes(stateResults[0].capabilities, 0, 'Read') &&
          contributes(stateResults[0].capabilities, 1, 'Tags'),
        'Novel C did not actually execute A and B capabilities',
      );
      if (novel) {
        recordPairResult(novel);
        if (automatic) {
          assert.equal(stateResults[0].planSource, 'local', 'C must be selected locally');
          assert.equal(row.comparison.throughFirstC.proposalRequests, 0);
          assert.equal(row.comparison.modelTurns, 0);
          row.sharedSteps = await sharedStepRefs(
            store.directory,
            row.tasks.slice(0, 2),
            stateResults[0].capabilities,
          );
        }
        row.comparison.executedCapabilities = stateResults[0].capabilities;
        row.comparison.planSource = stateResults[0].planSource;
        row.finalState = await app.snapshot();
        row.completed = true;
        return;
      }
      assert.equal(stateResults[3].actions, 0, 'A complete record should require no actions');
      assert.ok(
        stateResults[2].actions < stateResults[0].actions,
        'An existing tag should eliminate work',
      );
      row.novelTaskBusinessReadyMs = row.tasks[2].businessReadyMs;
      // Find a shared control from actual admitted A/B bindings, without a site selector map.
      const catalog = await library.candidates(app.origin, recordKind);
      const targets = (ids: { id: string }[]) =>
        catalog
          .filter((item) => ids.some((part) => part.id === item.id))
          .flatMap((item: any) =>
            item.steps.map((step: any) => ({
              capability: item.id,
              sourceExperience: item.evidence[0].experience,
              sourceStep: step.sourceIndex,
              action: decode(step.action, bInput) as Action,
            })),
          )
          .flatMap(
            ({
              capability,
              sourceExperience,
              sourceStep,
              action,
            }: {
              capability: string;
              sourceExperience: string;
              sourceStep: number;
              action: Action;
            }) =>
              Object.values(action.bindings ?? {}).map((target) => ({
                capability,
                sourceExperience,
                sourceStep,
                target,
              })),
          )
          .filter(
            ({ target }: { target: Action['target'] }) =>
              ['textbox', 'searchbox', 'combobox'].includes(target?.role ?? '') &&
              !!target?.name &&
              !target.ref &&
              target.index === undefined,
          );
      const candidates = [
        ...new Map(
          targets(a)
            .filter((left) =>
              targets(b).some((right) => isDeepStrictEqual(left.target, right.target)),
            )
            .map((item) => [JSON.stringify(item.target), item]),
        ).values(),
      ];
      assert.equal(
        candidates.length,
        1,
        'No unique actually-learned shared input control; preserve the attempt',
      );
      const shared = candidates[0];
      const fault: FaultPlan = {
        target: {
          role: shared.target.role as FaultPlan['target']['role'],
          name: shared.target.name!,
        },
        replacement: 'Updated mailbox search',
        sourceExperience: shared.sourceExperience,
        sourceStep: shared.sourceStep,
        input: 'subject',
        sourceTarget: shared.target,
      };
      row.drift = { ...fault, installed: stamp() };
      await installDrift(browser.page, fault);
      const repair: NonNullable<Parameters<CapabilityLibrary['run']>[0]['repair']> = async (
        context,
      ) => {
        const entry: Record<string, any> = { started: stamp(), context };
        row.repairs.push(entry);
        const original = tools.find((tool) => tool.name === context.action.tool);
        assert.ok(original);
        const paths = Object.keys(context.action.bindings ?? {});
        assert.equal(paths.length, 1, 'The controlled fault must affect one bound native target');
        const patchTool: ModelTool = {
          name: 'submit_patch',
          description:
            'Return the current snapshot ref of the replacement control. This proposal tool performs no UI action.',
          inputSchema: {
            type: 'object',
            properties: { ref: { type: 'string' } },
            required: ['ref'],
            additionalProperties: false,
          },
        };
        let replacement: Action | undefined;
        const repaired = await agent(round, method, 'shared-repair').runUntilTool(
          'A shared learned control no longer resolves before dispatch. Identify its current snapshot ref and call the supplied submit_patch tool with {"ref":"<current snapshot ref>"}. Call the tool; a prose answer cannot complete this task. submit_patch is a proposal only and does not execute a write. ReflexRun preserves the entire original action payload and only rebinds the target. Original action: ' +
            JSON.stringify(context.action) +
            '. Current snapshot: ' +
            context.observation.text,
          [patchTool],
          serialHandler(async (_name, args) => {
            assert.equal(typeof args.ref, 'string');
            const proposed: NativeCall = {
              name: original.name,
              arguments: structuredClone(context.action.args!),
            };
            setAt(proposed.arguments, paths[0], args.ref);
            replacement = await host.translate(proposed);
            entry.proposed = replacement;
            entry.ready = stamp();
            return content({ accepted: true });
          }),
          'submit_patch',
        );
        report.modelRuns.push({ round, method, stage: 'shared-repair', ...repaired });
        assert.ok(replacement);
        return replacement;
      };
      const driftA = await execute(
        'A.read',
        { subject: app.inputs[5].subject },
        rules(true),
        a.map((part) => part.id),
        repair,
      );
      const driftB = await execute(
        'B.tag',
        app.inputs[6] as Inputs,
        rules(false, app.inputs[6].tag),
        b.map((part) => part.id),
        repair,
      );
      const driftC = await execute(
        'C.combined',
        { subject: app.inputs[1].subject, tag: 'Followup' },
        rules(true, 'Followup'),
        c,
        repair,
      );
      assert.equal(
        row.repairs.length,
        1,
        'The same changed shared control requested more than one model repair',
      );
      row.catalog = await library.candidates(app.origin, recordKind);
      row.sharedReuse = [driftA, driftB, driftC].map((result, index) => ({
        task: ['A', 'B', 'C'][index],
        repairs: result.repairs,
        usedRenamedControl: result.trace.some(
          (step) =>
            step.dispatched &&
            !step.error &&
            Object.values(step.action.bindings ?? {}).some(
              (target) => target.name === fault.replacement,
            ),
        ),
      }));
      assert.deepEqual(
        row.sharedReuse.map((item: any) => [item.repairs, item.usedRenamedControl]),
        [
          [1, true],
          [0, true],
          [0, true],
        ],
        'Every changed task must use the actual shared replacement',
      );
      row.finalState = await app.snapshot();
      row.faultWitness = await driftState(browser.page, fault);
      row.dependencies = await library.dependencies();
      assert.equal(row.faultWitness.replacementCount, 1, 'Shared renamed-control witness missing');
      assert.ok(row.faultWitness.injection.patches >= 1);
      row.completed = true;
    } catch (error) {
      row.error = error instanceof Error ? error.stack : String(error);
      process.stderr.write(
        `round ${round} failed: ${error instanceof Error ? error.message.slice(0, 450) : String(error)}\n`,
      );
    } finally {
      if (browser) {
        const video = browser.page.video();
        await browser.close();
        if (video) {
          row.rawVideo = join(directory, actor + '.webm');
          await copyFile(await video.path(), row.rawVideo);
        }
      }
      await app.close();
      row.ended = stamp();
      await save();
    }
  };
  try {
    for (let round = 1; round <= rounds; round++) {
      if (!paired) {
        const row: Record<string, any> = {};
        report.rounds.push(row);
        await runActor(round, 'reflex', row);
        continue;
      }
      const order =
        round % 2 ? (['reflex', 'baseline'] as const) : (['baseline', 'reflex'] as const);
      const results = { baseline: {}, reflex: {} } as Record<
        'baseline' | 'reflex',
        Record<string, any>
      >;
      const pair = {
        round,
        order,
        results,
        completed: false,
        error: undefined as string | undefined,
      };
      report.rounds.push(pair);
      for (const method of order) await runActor(round, method, results[method]);
      if (results.baseline.completed && results.reflex.completed) {
        try {
          assert.equal(results.baseline.toolsSha256, results.reflex.toolsSha256);
          assert.deepEqual(
            results.baseline.comparison.startingMailbox,
            results.reflex.comparison.startingMailbox,
          );
          assert.deepEqual(
            pairedState(results.baseline.finalState),
            pairedState(results.reflex.finalState),
          );
          pair.completed = true;
        } catch (error) {
          pair.error = error instanceof Error ? error.stack : String(error);
        }
      }
      await save();
    }
    assert.deepEqual(await hashes(), sourceHashes, 'Source changed during the campaign');
    assert.equal(
      new Set(
        report.modelRuns.map((run: any) =>
          JSON.stringify([run.model, run.provider, run.reasoningEffort]),
        ),
      ).size,
      1,
      'Original model configuration changed',
    );
    report.actualModel = {
      model: report.modelRuns[0].model,
      provider: report.modelRuns[0].provider,
      reasoningEffort: report.modelRuns[0].reasoningEffort,
    };
    report.finished = true;
    report.completed = report.rounds.every((row: { completed: boolean }) => row.completed);
    if (!report.completed) process.exitCode = 1;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    report.ended = stamp();
    await save();
  }
  process.stdout.write(
    JSON.stringify({
      completed: report.completed,
      rounds: report.rounds.length,
      report: join(directory, 'raw-report.json'),
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await benchmarkCapabilities();

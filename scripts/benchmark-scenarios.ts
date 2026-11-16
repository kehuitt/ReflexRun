import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { CodexToolAgent, type ModelTool } from '../src/model/codex.js';
import { ToolProxy, type NativeCall } from '../src/proxy/index.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { runMemoryBatch } from '../src/memory/batch.js';
import type { Action, Check, Inputs, MemoryResult } from '../src/memory/types.js';
import {
  completeTool,
  freshEvaluationDirectory,
  LiveBrowser,
  parseSettleMs,
  plain,
  serveUnmodifiedApp,
  targetOnlyNativePatch,
} from './live-runtime.js';
import { confirmedReadback, stamp, summarizeTiming, type TaskTimeline } from './showcase-timing.js';

export type Scenario = 'expense' | 'invoice' | 'mail';
export type DraftRecord = { id: string; scenario: Scenario; fields: Inputs };
export const scenarioInputs: Record<'expense', Inputs[]> = {
  expense: [
    {
      description: 'Client workshop train',
      category: 'travel',
      categoryLabel: 'Travel',
      amount: '48.50',
      date: '2026-11-03',
      note: 'Round trip to the synthetic planning workshop.',
    },
    {
      description: 'Team notebooks',
      category: 'office',
      categoryLabel: 'Office',
      amount: '24.80',
      date: '2026-11-04',
      note: 'Four notebooks for the example design team.',
    },
    {
      description: 'Project lunch',
      category: 'meals',
      categoryLabel: 'Meals',
      amount: '36.20',
      date: '2026-11-05',
      note: 'Working lunch for the example review session.',
    },
    {
      description: 'Conference shuttle',
      category: 'travel',
      categoryLabel: 'Travel',
      amount: '18.60',
      date: '2026-11-06',
      note: 'Shuttle transfer for the synthetic conference.',
    },
    {
      description: 'Presentation markers',
      category: 'office',
      categoryLabel: 'Office',
      amount: '12.40',
      date: '2026-11-07',
      note: 'Whiteboard supplies for the example demo.',
    },
  ],
};

/** Independent record predicate; a toast or a matching display name cannot establish success. */
export function exactNewDraft(
  baseline: DraftRecord[],
  records: DraftRecord[],
  scenario: Scenario,
  fields: Inputs,
) {
  const previous = new Map(baseline.map((row) => [row.id, row]));
  const added = records.filter((row) => !previous.has(row.id));
  const unchanged = baseline.every((row) =>
    records.some((current) => current.id === row.id && isDeepStrictEqual(current, row)),
  );
  const unique =
    records.every(
      (row) => typeof row.id === 'string' && row.id.length > 0 && row.scenario === scenario,
    ) && new Set(records.map((row) => row.id)).size === records.length;
  const confirmed =
    unique &&
    unchanged &&
    records.length === baseline.length + 1 &&
    added.length === 1 &&
    isDeepStrictEqual(added[0].fields, fields);
  return {
    confirmed,
    terminal: added.length > 0 || !unchanged || !unique,
    reason: !unchanged
      ? 'Prior record changed or disappeared'
      : !unique
        ? 'Wrong scenario, empty id or duplicate id'
        : added.length
          ? 'Wrong fields or additional write'
          : 'Missing write',
  };
}

export type MessageRecord = { id: string; subject: string; sender: string; folder: string };
export function exactMailMove(
  previous: MessageRecord[],
  current: MessageRecord[],
  mailId: string,
  folder: string,
) {
  const target = previous.find((row) => row.id === mailId);
  return (
    !!target &&
    target.folder !== folder &&
    isDeepStrictEqual(
      current,
      previous.map((row) => (row.id === mailId ? { ...row, folder } : row)),
    )
  );
}

export type DownloadRecord = { id: string; filename: string; sha256: string; content: string };
export function exactInvoiceDownload(
  previous: DownloadRecord[],
  current: DownloadRecord[],
  orderId: string,
  amount: string,
) {
  const added = current.slice(previous.length);
  const unchanged = isDeepStrictEqual(current.slice(0, previous.length), previous);
  const file = added[0],
    xref = file?.content.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  return (
    unchanged &&
    added.length === 1 &&
    !!file.id &&
    new Set(current.map((row) => row.id)).size === current.length &&
    file.filename === `invoice-${orderId}.pdf` &&
    file.content.startsWith('%PDF-1.4') &&
    !!xref &&
    file.content.slice(Number(xref[1])).startsWith('xref') &&
    /\/Type\s*\/Page\b/.test(file.content) &&
    /\/Contents\b/.test(file.content) &&
    file.content.includes(`(Order: ${orderId})`) &&
    file.content.includes(`(Amount: CNY ${amount})`)
  );
}

const nativeNames = [
  'browser_snapshot',
  'browser_type',
  'browser_press_key',
  'browser_click',
  'browser_fill_form',
  'browser_select_option',
];
const text = (value: unknown) => [{ type: 'inputText' as const, text: JSON.stringify(value) }];
const phaseAt = (index: number) => (index === 0 ? 'cold' : index < 3 ? 'normal' : 'changed');
const storageKey = (scenario: Scenario, actor: string) => `reflexrun:portal:${scenario}:${actor}`;
export const writtenFields = (scenario: Scenario, inputs: Inputs): Inputs =>
  scenario === 'invoice'
    ? { orderId: inputs.orderId, amount: inputs.amount }
    : scenario === 'mail'
      ? { mailId: inputs.mailId, folder: inputs.folder }
      : Object.fromEntries(Object.entries(inputs).filter(([key]) => !key.endsWith('Label')));
const prompt = (scenario: Scenario, fields: Inputs) => {
  const task =
    scenario === 'invoice'
      ? 'Download the invoice for the specified order, keeping other orders unchanged'
      : scenario === 'mail'
        ? 'Move the specified message to the requested folder, keeping every other message unchanged'
        : 'Create exactly one expense draft with every provided field exactly';
  return `The browser is already open on a synthetic local business page. ${task}. Task values: ${JSON.stringify(fields)}. A field ending in Label is the display alias of the same business field, not an extra control; either label or code may be used where the original tools support it. Discover its interface from the live browser. This local task never sends expenses or emails externally. When visibly finished, call task_complete with an exact literal UI completion condition. That tool independently verifies the actual business records and, for invoices, the real downloaded PDF. If its response supplies nextFields, perform the same task with those next values and call task_complete again; otherwise stop. Use snapshots already returned by actions when sufficient. Do not use evaluator tabs or external resources.`;
};

/** Bundled synthetic portals, not an unmodified-site benchmark. */
export async function benchmarkScenarios() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'all' },
      evidence: { type: 'string' },
      out: { type: 'string' },
      order: { type: 'string', default: 'baseline-first' },
      'no-video': { type: 'boolean' },
      'settle-ms': { type: 'string', default: '0' },
    },
  });
  const scenarios: Scenario[] = ['expense', 'invoice', 'mail'];
  const selected = values.scenario === 'all' ? scenarios : [values.scenario as Scenario];
  assert.ok(
    selected.every((key) => scenarios.includes(key)),
    '--scenario must be expense, invoice, mail or all',
  );
  assert.ok(
    ['baseline-first', 'reflex-first'].includes(values.order!),
    '--order must be baseline-first or reflex-first',
  );
  const settleMs = parseSettleMs(values['settle-ms']!);
  if (values.out) {
    try {
      await access(resolve(values.out));
      throw new Error('--out already exists; preserve prior evidence');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const renderer = join(root, 'docs/playground/scenarios.js');
  const rendererHash = createHash('sha256')
    .update(await readFile(renderer))
    .digest('hex');
  const fixture = (await import(pathToFileURL(renderer).href)) as {
    invoiceOrders: { orderId: string; title: string; amount: string }[];
    mailMessages: MessageRecord[];
  };
  const inputs: Record<Scenario, Inputs[]> = {
    ...scenarioInputs,
    invoice: fixture.invoiceOrders.map(({ orderId, title, amount }) => ({
      orderId,
      title,
      amount,
    })),
    mail: fixture.mailMessages.map(({ id, subject, folder }, index) => ({
      mailId: id,
      subject,
      sourceFolder: folder,
      folder: ['receipts', 'follow-up', 'archive', 'receipts', 'follow-up'][index],
      folderLabel: ['Receipts', 'Follow-up', 'Archive', 'Receipts', 'Follow-up'][index],
    })),
  };
  assert.ok(
    selected.every((scenario) => inputs[scenario].length === 5),
    'Every scenario must supply five tasks',
  );
  const directory = await freshEvaluationDirectory(values.evidence);
  const app = await serveUnmodifiedApp(join(root, 'docs/playground'));
  const order = values.order === 'reflex-first' ? ['reflex', 'baseline'] : ['baseline', 'reflex'];
  const report: Record<string, any> = {
    schemaVersion: 1,
    started: stamp(),
    directory,
    fixture: { kind: 'synthetic local business portals', rendererSha256: rendererHash },
    verification: {
      level: 'per-item-independent-storage-readback',
      timeoutMs: 2000,
      source:
        'Original portal localStorage read from a separate script-free tab in the same isolated context',
      checks: [
        'every field exact',
        'scenario identity',
        'one new nonempty unique id',
        'prior records unchanged',
        'invoice: actual new PDF, basic file structure, order/amount and prior download bytes unchanged',
        'mail: exact target folder change and every other message unchanged',
        'authorized origin',
      ],
    },
    configuration: {
      viewport: { width: 1280, height: 900 },
      settleMs,
      video: !values['no-video'],
      order,
      initialContext: 'model requests its own first observation',
      codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      playwrightMcp: JSON.parse(
        await readFile(join(root, 'node_modules/@playwright/mcp/package.json'), 'utf8'),
      ).version,
    },
    fairness: {
      repetitionsPerScenario: 1,
      fieldsIdentical: true,
      selectValues:
        'Both methods receive each supplied selection business code and its display Label alias. The model may use either where the original native tools support it; hidden HTML option values are not inferred from snapshots.',
      baselineContext:
        'One continuous original-model turn for all five records, preserving prior browser/tool context',
      reflexContext:
        'Original model explores the first record; local replay handles the next two; one bounded original-model repair handles the renamed action target, then its remaining batch reuses that repair',
      limits:
        'One pair per scenario on synthetic portals built for this demonstration. This is an integration test, not evidence of universal speed, arbitrary-site compatibility. Expense categories, invoice identities and mail folders vary across tasks. Both methods use the same original native tools and independent readback. ReflexRun retains its normal UI-goal, scope, intent and unknown-effect safeguards. Invoice verification checks simple uncompressed fixture PDFs, not arbitrary real-world PDF semantics.',
      timing:
        'Cold task clock stops at independently confirmed storage for both methods; memory readiness and model completion are separate. Warm/changed phase wall clocks include local queue and persistence work through phase completion. Browser setup, fixture rename and final model closing prose are excluded from task times. Native recorded videos run at original speed; no pacing waits are inserted.',
    },
    scenarios: {},
    modelRuns: [],
    events: [],
    completed: false,
  };
  const save = () =>
    writeFile(join(directory, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  const agent = (scenario: Scenario, method: string, phase: string) =>
    new CodexToolAgent({
      cwd: join(directory, 'model-cwd'),
      timeoutMs: 420_000,
      onEvent: (event) => {
        const row = {
          ...event,
          scenario,
          method,
          phase,
          monotonicMs:
            typeof event.monotonicMs === 'number' ? event.monotonicMs : performance.now(),
        };
        report.events.push(row);
        appendFileSync(join(directory, 'model-events.jsonl'), JSON.stringify(row) + '\n');
        if (['model-start', 'tool-request', 'failed'].includes(event.type))
          process.stderr.write(
            `${scenario}/${method}/${phase}: ${event.type} ${event.tool ?? event.error ?? event.model ?? ''}\n`,
          );
      },
    });
  async function execute(scenario: Scenario, method: string) {
    const actor = `${scenario}-${method}`;
    const result: Record<string, any> = (report.scenarios[scenario].results[method] = {
      browserLaunch: stamp(),
      rows: [],
      phases: [],
      nativeCalls: [],
      readbacks: [],
      evaluatorEvents: [],
      proxyTimings: [],
    });
    const browser = await LiveBrowser.open(app.origin, actor, directory, {
      pagePath: `/?portal=${scenario}&run=${actor}`,
      viewport: report.configuration.viewport,
      recordVideo: report.configuration.video,
      settleMs,
      onPageCreated: (time) => {
        result.pageCreated = time;
      },
    });
    result.browserReady = stamp();
    let proxy: ToolProxy | undefined;
    try {
      const downloads: Promise<DownloadRecord & { path: string; failure?: string }>[] = [];
      browser.page.on('download', (download) => {
        const id = String(downloads.length + 1),
          path = join(directory, `${actor}-download-${id}.pdf`);
        downloads.push(
          (async () => {
            try {
              assert.equal(
                new URL(download.url()).origin,
                app.origin,
                'Download left its authorized origin',
              );
              await download.saveAs(path);
              const bytes = await readFile(path);
              return {
                id,
                path,
                filename: download.suggestedFilename(),
                url: download.url(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
                content: bytes.toString('latin1'),
              };
            } catch (error) {
              return {
                id,
                path,
                filename: download.suggestedFilename(),
                sha256: '',
                content: '',
                failure: String(error),
              };
            }
          })(),
        );
      });
      const downloaded = async () =>
        Promise.all(
          (await Promise.all(downloads)).map(async (file) => {
            if (file.failure) return file;
            const bytes = await readFile(file.path);
            return {
              ...file,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              content: bytes.toString('latin1'),
            };
          }),
        );
      const nativeCall = browser.port.callTool.bind(browser.port);
      browser.port.callTool = async (call) => {
        const started = stamp();
        try {
          const response = await nativeCall(call);
          result.nativeCalls.push({ call, started, ended: stamp(), response });
          return response;
        } catch (error) {
          result.nativeCalls.push({ call, started, ended: stamp(), error: String(error) });
          throw error;
        }
      };
      const records = () =>
        browser.reader.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as DraftRecord[],
          storageKey(scenario, actor),
        );
      let prior = await records();
      assert.deepEqual(prior, [], 'Every actor must start with an isolated empty record store');
      const messages = () =>
        browser.reader.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as MessageRecord[],
          storageKey(scenario, actor) + ':messages',
        );
      let previousMessages = scenario === 'mail' ? await messages() : [];
      let previousDownloads: DownloadRecord[] = [];
      if (scenario === 'mail')
        assert.deepEqual(
          previousMessages,
          fixture.mailMessages,
          'Mailbox seed must match its declared synthetic task fixture',
        );
      const verify = async (fields: Inputs) => {
        const started = stamp();
        let outcome = {
          status: 'rejected',
          source: report.verification.source,
          reason: 'Missing write',
        };
        do {
          const current = await records();
          const check = exactNewDraft(prior, current, scenario, writtenFields(scenario, fields));
          if (new URL(browser.page.url()).origin !== app.origin) {
            outcome.reason = 'Execution left its authorized origin';
            break;
          }
          const currentMessages = scenario === 'mail' ? await messages() : [];
          const currentDownloads = scenario === 'invoice' ? await downloaded() : [];
          const mailConfirmed =
            scenario !== 'mail' ||
            exactMailMove(
              previousMessages,
              currentMessages,
              String(fields.mailId),
              String(fields.folder),
            );
          const fileConfirmed =
            scenario !== 'invoice' ||
            exactInvoiceDownload(
              previousDownloads,
              currentDownloads,
              String(fields.orderId),
              String(fields.amount),
            );
          if (check.confirmed && mailConfirmed && fileConfirmed) {
            prior = current;
            previousMessages = currentMessages;
            previousDownloads = currentDownloads;
            outcome = { status: 'confirmed', source: report.verification.source, reason: '' };
            break;
          }
          outcome.reason = !check.confirmed
            ? check.reason
            : !mailConfirmed
              ? 'Mailbox identity, contents or target folder differs'
              : 'Actual PDF download is missing, incorrect, additional, or changed a prior file';
          if (
            (!check.confirmed && check.terminal) ||
            (check.confirmed && !mailConfirmed) ||
            (check.confirmed &&
              !fileConfirmed &&
              currentDownloads.length > previousDownloads.length) ||
            performance.now() - started.monotonicMs >= 2000
          )
            break;
          await new Promise((done) => setTimeout(done, 50));
        } while (true);
        const drift = result.evaluatorEvents.at(-1);
        const controlName = drift
          ? await browser.page
              .locator(
                scenario === 'invoice'
                  ? 'button[name="download-invoice"]'
                  : scenario === 'mail'
                    ? 'button[name="move-message"]'
                    : 'button[type="submit"]',
              )
              .getAttribute('aria-label')
          : undefined;
        if (drift && controlName !== drift.to)
          outcome = {
            status: 'rejected',
            source: report.verification.source,
            reason: 'The evaluator control rename did not persist across this item',
          };
        result.readbacks.push({ fields, started, observed: stamp(), outcome, controlName });
        return { ...outcome, status: outcome.status as 'confirmed' | 'rejected' };
      };
      const tools: ModelTool[] = [
        ...(await browser.tools(nativeNames)).map(({ name, description, inputSchema }) => ({
          name,
          description: description ?? name,
          inputSchema,
        })),
        completeTool,
      ];
      result.tools = tools;
      result.toolsSha256 = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
      const fields = inputs[scenario];
      const rename = async () => {
        const started = stamp();
        const button = browser.page.locator(
          scenario === 'invoice'
            ? 'button[name="download-invoice"]'
            : scenario === 'mail'
              ? 'button[name="move-message"]'
              : 'button[type="submit"]',
        );
        assert.equal(await button.count(), 1, 'Drift must rename one existing submit control');
        const from = await button.textContent();
        const name = {
          expense: 'Save expense',
          invoice: 'Download PDF',
          mail: 'File message',
        }[scenario];
        await button.evaluate((element, name) => {
          element.textContent = name;
          element.setAttribute('aria-label', name);
        }, name);
        result.evaluatorEvents.push({
          type: 'rename-submit-label',
          started,
          ended: stamp(),
          from,
          to: name,
        });
      };
      const cold: TaskTimeline = { started: stamp() };
      result.executionStarted = cold.started;
      if (method === 'baseline') {
        let index = 0,
          itemStarted = cold.started,
          phaseStarted = cold.started;
        const run = await agent(scenario, method, 'continuous-queue').run(
          prompt(scenario, fields[0]),
          tools,
          async (name, args) => {
            if (name !== 'task_complete')
              return [
                {
                  type: 'inputText',
                  text: plain(
                    await browser.port.callTool({
                      name,
                      arguments: args as NativeCall['arguments'],
                    }),
                  ),
                },
              ];
            assert.ok(index < fields.length, 'Queue already completed');
            const outcome =
              index === 0
                ? await confirmedReadback(cold, () => verify(fields[index]))
                : await verify(fields[index]);
            assert.equal(outcome.status, 'confirmed', JSON.stringify(outcome));
            const ended = index === 0 ? cold.taskReady! : stamp(),
              phase = phaseAt(index);
            result.rows.push({
              index,
              phase,
              fields: fields[index],
              started: itemStarted,
              ended,
              elapsedMs: ended.monotonicMs - itemStarted.monotonicMs,
              outcome,
              declaredGoal: args.goal,
            });
            index++;
            if ([1, 3, 5].includes(index))
              result.phases.push({
                phase,
                started: phaseStarted,
                ended,
                elapsedMs: ended.monotonicMs - phaseStarted.monotonicMs,
                confirmed: phase === 'cold' ? 1 : 2,
              });
            if (index === 3) await rename();
            itemStarted = stamp();
            if ([1, 3].includes(index)) phaseStarted = itemStarted;
            return text({
              outcome,
              nextFields: fields[index] ?? null,
              remaining: fields.length - index,
            });
          },
        );
        report.modelRuns.push({ ...run, scenario, method, phase: 'continuous-queue' });
        assert.equal(index, 5, 'The original model must finish the full five-record queue');
        result.modelTurnCompleted = stamp();
        Object.assign(result.phases[0], summarizeTiming(cold), { timing: cold });
      } else {
        const store = new ExperienceStore(join(directory, `${scenario}-memory`));
        proxy = new ToolProxy(browser.port, store, undefined, {
          onTiming: (event) => result.proxyTimings.push(event),
        });
        await proxy.host.initialize();
        const key = `demo.${scenario}.process`;
        const first = await proxy.begin({
          key,
          job: 'cold',
          inputs: fields[0],
          verification: 'readback',
          allowedScopes: [app.origin],
          readback: () => confirmedReadback(cold, () => verify(fields[0])),
        });
        assert.equal(first.mode, 'explore');
        let completion: any, learning: Promise<MemoryResult> | undefined;
        const run = await agent(scenario, method, 'cold').run(
          prompt(scenario, fields[0]),
          tools,
          async (name, args) => {
            if (name === 'task_complete') {
              completion = await proxy!.finish(args.goal as Check);
              result.coldCompletion = completion;
              if (completion.mode === 'done')
                learning = proxy!.waitForLearning().then((learned) => {
                  assert.ok(learned);
                  if (learned.learning === 'ready') cold.memoryReady = stamp();
                  return learned;
                });
              return text({ ...completion, nextFields: null, remaining: 0 });
            }
            return [
              {
                type: 'inputText',
                text: plain(
                  await proxy!.call({ name, arguments: args as NativeCall['arguments'] }),
                ),
              },
            ];
          },
        );
        cold.modelTurnReady = stamp();
        report.modelRuns.push({ ...run, scenario, method, phase: 'cold' });
        assert.equal(completion?.result?.status, 'completed', JSON.stringify(completion));
        assert.ok(learning);
        const learned = await learning;
        assert.equal(learned.learning, 'ready', learned.learningError ?? JSON.stringify(learned));
        assert.equal(
          (await store.list()).length,
          1,
          'First autonomous model path must save one experience',
        );
        result.rows.push({
          index: 0,
          phase: 'cold',
          fields: fields[0],
          started: cold.started,
          ended: cold.taskReady,
          result: learned,
        });
        result.phases.push({
          phase: 'cold',
          ...summarizeTiming(cold),
          timing: cold,
          started: cold.started,
          ended: cold.taskReady,
          elapsedMs: summarizeTiming(cold).taskReadyMs,
          confirmed: 1,
          localTimings: learned.timings,
        });
        result.memoryAfterCold = await store.list();
        let repairs = 0;
        const runner = new Reflex({
          host: proxy.host,
          store,
          repair: async (context) => {
            repairs++;
            const original = tools.find((tool) => tool.name === context.failed.tool);
            assert.ok(original, 'Failed original tool schema must exist');
            const patch: ModelTool = {
              name: 'submit_patch',
              description:
                'Propose one native replacement target for the failed action. Do not execute any write.',
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
            const repairStarted = stamp();
            const repaired = await agent(scenario, method, 'repair').runUntilTool(
              `A learned action no longer resolves before dispatch. Propose submit_patch using the supplied original tool schema and the current live snapshot. Change only its target; retain all non-target payload and the original effect boundary. Do not execute a write. The snapshot is already supplied; request another only if necessary. Inputs: ${JSON.stringify(context.task.inputs)}. Failed call: ${JSON.stringify({ name: context.failed.tool, arguments: context.failed.args })}. Live observation: ${context.observation.text}`,
              [tools.find((tool) => tool.name === 'browser_snapshot')!, patch],
              async (name, args) => {
                if (name !== 'submit_patch')
                  return [
                    {
                      type: 'inputText',
                      text: plain(
                        await browser.port.callTool({
                          name,
                          arguments: args as NativeCall['arguments'],
                        }),
                      ),
                    },
                  ];
                const proposed = args.calls as NativeCall[];
                assert.equal(proposed.length, 1, 'A target repair must preserve one action');
                assert.equal(proposed[0].name, original.name);
                assert.ok(
                  targetOnlyNativePatch(
                    { name: context.failed.tool!, arguments: context.failed.args! },
                    proposed[0],
                    Object.keys(context.failed.bindings ?? {}),
                  ),
                  'Repair changed non-target payload',
                );
                translated = await Promise.all(proposed.map((call) => proxy!.host.translate(call)));
                result.repairPatch = {
                  started: repairStarted,
                  ready: stamp(),
                  nativeCalls: proposed,
                  schema: patch.inputSchema,
                };
                return text({ received: true });
              },
              'submit_patch',
            );
            report.modelRuns.push({ ...repaired, scenario, method, phase: 'repair' });
            result.repairPatch.ended = stamp();
            result.repairPatch.modelTimings = repaired.timings;
            assert.ok(translated?.length, 'Repair must have a grounded native translation');
            return translated;
          },
        });
        const items = fields.slice(1).map((inputs, index) => ({
          id: `item-${index + 1}`,
          label: `${scenario} item ${index + 2}`,
          inputs,
          facts: {},
        }));
        for (const phase of ['normal', 'changed']) {
          if (phase === 'changed') await rename();
          const started = stamp(),
            previousRepairs = repairs;
          const batch = await runMemoryBatch(runner, {
            id: `${scenario}-four`,
            operation: key,
            policy: () => ({ revision: 1, rules: [] }),
            verification: 'readback',
            allowedScopes: [app.origin],
            timeoutMs: 240_000,
            items: phase === 'normal' ? items.slice(0, 2) : items,
            readback: (item) => verify(item.inputs),
            onItem: (row, itemResult) => {
              result.rows.push({ ...row, phase, observed: stamp(), result: itemResult });
            },
          });
          const ended = stamp();
          result.phases.push({
            phase,
            started,
            ended,
            elapsedMs: ended.monotonicMs - started.monotonicMs,
            repairs: repairs - previousRepairs,
            batch,
            confirmed: 2,
          });
          await save();
          assert.ok(
            batch.rows.every((row) => row.status === 'confirmed'),
            JSON.stringify(batch.rows),
          );
          assert.equal(
            repairs - previousRepairs,
            phase === 'changed' ? 1 : 0,
            'One repair must serve the entire changed batch',
          );
        }
        result.memories = await store.list();
      }
      result.finalRecords = await records();
      if (scenario === 'mail') result.finalMessages = await messages();
      if (scenario === 'invoice') result.downloads = await downloaded();
      assert.equal(result.finalRecords.length, 5);
      assert.deepEqual(
        result.finalRecords.map((row: DraftRecord) => row.fields),
        fields.map((input) => writtenFields(scenario, input)),
      );
    } finally {
      await proxy?.cancel();
      const video = browser.page.video();
      result.browserClosing = stamp();
      await browser.close();
      result.browserClosed = stamp();
      if (video) {
        result.rawVideo = join(directory, `${actor}.webm`);
        await copyFile(await video.path(), result.rawVideo);
      }
      await save();
    }
  }
  try {
    for (const scenario of selected) {
      report.scenarios[scenario] = { inputs: inputs[scenario], results: {} };
      for (const method of order) await execute(scenario, method);
      const results = report.scenarios[scenario].results;
      assert.equal(
        results.baseline.toolsSha256,
        results.reflex.toolsSha256,
        'Original offered tools and schemas must match',
      );
    }
    assert.equal(
      new Set(
        report.modelRuns.map((run: any) =>
          JSON.stringify([run.model, run.provider, run.reasoningEffort]),
        ),
      ).size,
      1,
      'Both methods must use the same model configuration',
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile(renderer))
        .digest('hex'),
      rendererHash,
      'Shared renderer changed during measurement',
    );
    report.completed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    report.ended = stamp();
    await save();
    await app.close();
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
    process.stderr.write(`Saved private evidence: ${directory}\nCompleted: ${report.completed}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await benchmarkScenarios();

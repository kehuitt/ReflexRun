import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { resolve, extname, join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext, Page } from 'playwright';
import type { createConnection } from '@playwright/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fromPlaywrightSnapshot, type NativeCall, type ToolPort } from '../src/proxy/playwright.js';
import type { ModelTool } from '../src/model/codex.js';
import { ExperienceStore } from '../src/memory/store.js';

export type Todo = { id: string; title: string; completed: boolean };
export const plain = (result: CallToolResult) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const withoutTargets = (value: unknown, targets: Set<string>, path = ''): unknown => {
  if (targets.has(path)) return null;
  if (Array.isArray(value))
    return value.map((v, i) => withoutTargets(v, targets, path ? `${path}.${i}` : String(i)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !targets.has(path ? `${path}.${key}` : key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, withoutTargets(v, targets, path ? `${path}.${key}` : key)]),
    );
  return value;
};
export function targetOnlyNativePatch(
  original: NativeCall,
  proposed: NativeCall,
  targetPaths: string[],
) {
  const targets = new Set(targetPaths);
  if (
    ['browser_click', 'browser_type', 'browser_hover', 'browser_select_option'].includes(
      original.name,
    )
  )
    targets.add('element');
  return (
    original.name === proposed.name &&
    isDeepStrictEqual(
      withoutTargets(original.arguments, targets),
      withoutTargets(proposed.arguments, targets),
    )
  );
}
export const contract = {
  level: 'per-item-independent-storage-readback',
  timeoutMs: 2000,
  pollMs: 100,
  checks: [
    'exact new title',
    'completed=false',
    'one new nonempty id',
    'no duplicate title/id',
    'prior records unchanged',
    'authorized origin',
  ],
  source:
    'Original app localStorage, read from a separate script-free tab in the same isolated browser context; not an external database',
};
export const completeTool: ModelTool = {
  name: 'task_complete',
  description:
    'After the requested task is visibly complete, declare the observed UI completion condition. This does not override independent storage validation.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'An exact literal substring currently visible in the browser, not a sentence describing success.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    required: ['goal'],
    additionalProperties: false,
  },
};

export async function serveUnmodifiedApp(
  directory: string,
  trial?: { rename?: { from: string; to: string } },
) {
  const readers = new Map<string, () => Promise<Todo[]>>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (trial) {
        const existing = request.headers.cookie?.match(/(?:^|; )reflex-eval=([\w-]+)/)?.[1];
        const session = existing ?? randomUUID();
        if (!existing)
          response.setHeader(
            'set-cookie',
            `reflex-eval=${session}; Path=/; HttpOnly; SameSite=Strict`,
          );
        response.setHeader('cache-control', 'no-store');
        if (url.pathname === '/__audit') {
          const tag = createHash('sha256').update(session).digest('hex');
          response.setHeader('content-type', 'text/html');
          response.end(`<!doctype html><title>Independent local storage audit</title><output id="session">${tag}</output><pre id="records"></pre>
            <script>function read() { document.querySelector('#records').textContent = JSON.stringify((${readTodos.toString()})()); }
            read(); addEventListener('storage', read);</script>`);
          return;
        }
      }
      if (url.pathname === '/__records') {
        response.end('<!doctype html><title>Independent storage reader</title>Read-only evaluator');
        return;
      }
      if (url.pathname === '/__oracle') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ records: await readers.get(url.searchParams.get('session')!)!() }),
        );
        return;
      }
      const file = resolve(directory, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      const fromRoot = relative(directory, file);
      if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader(
        'content-type',
        (
          { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<
            string,
            string
          >
        )[extname(file)] ?? 'application/octet-stream',
      );
      if (trial?.rename && file === resolve(directory, 'index.html')) {
        const { from, to } = trial.rename,
          text = await readFile(file, 'utf8');
        const original = `placeholder="${from}"`;
        if (!text.includes(original))
          throw new Error('Evaluator could not apply its one-field revision');
        response.end(text.replace(original, `placeholder="${to}" aria-label="${to}"`));
        return;
      }
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No app address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    readers,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function readTodos(): Todo[] {
  return Object.values(localStorage).flatMap((value) => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter(
            (row) =>
              row &&
              typeof row.id === 'string' &&
              typeof row.title === 'string' &&
              typeof row.completed === 'boolean',
          )
        : [];
    } catch {
      return [];
    }
  });
}

export function exactNewTodo(baseline: Todo[], records: Todo[], title: string) {
  const previous = new Map(baseline.map((row) => [row.id, row]));
  const added = records.filter((row) => !previous.has(row.id));
  const unchanged = baseline.every((row) =>
    records.some(
      (current) => current.id === row.id && JSON.stringify(current) === JSON.stringify(row),
    ),
  );
  const unique =
    new Set(records.map((row) => row.id)).size === records.length &&
    new Set(records.map((row) => row.title)).size === records.length;
  const confirmed =
    added.length === 1 &&
    added[0].title === title &&
    added[0].completed === false &&
    !!added[0].id &&
    unchanged &&
    unique;
  return {
    confirmed,
    terminal: !!(added.length || !unchanged || !unique),
    reason: !unchanged
      ? 'Prior record changed'
      : !unique
        ? 'Duplicate title or id'
        : added.length
          ? 'Wrong or additional write'
          : 'Missing write',
  };
}

export function parseSettleMs(value: string | number = 500) {
  const ms = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new Error('--settle-ms must be a non-negative integer');
  return ms;
}

export class LiveBrowser {
  reads = 0;
  baseline: Todo[] = [];
  verificationMs = 0;
  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly reader: Page,
    readonly client: Client,
    readonly upstream: Awaited<ReturnType<typeof createConnection>>,
    readonly port: ToolPort,
    readonly url: string,
    readonly profile: string,
    readonly cdp: string,
  ) {}
  static async open(
    origin: string,
    name: string,
    directory: string,
    options: {
      recordVideo?: boolean;
      settleMs?: number;
      pagePath?: string;
      /** Disable the legacy storage-reader tab when the upstream app has its own backend. */
      readerPath?: string | false;
      viewport?: { width: number; height: number };
      onPageCreated?: (time: { at: string; monotonicMs: number }) => void;
      onPointerClick?: (click: { x: number; y: number; at: string; monotonicMs: number }) => void;
    } = {},
  ) {
    const settleMs = parseSettleMs(options.settleMs);
    // Resolve the browser packages in this workspace even when invoked by an embedded CUA REPL.
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const { createConnection } = require('@playwright/mcp') as typeof import('@playwright/mcp');
    const { Client } =
      require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } =
      require('@modelcontextprotocol/sdk/inMemory.js') as typeof import('@modelcontextprotocol/sdk/inMemory.js');
    const profile = join(directory, name + '-profile');
    const viewport = options.viewport ?? { width: 1280, height: 800 };
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport,
      args: ['--remote-debugging-port=0'],
      ...(options.recordVideo
        ? {
            recordVideo: {
              dir: join(directory, name + '-video'),
              size: viewport,
            },
          }
        : {}),
    });
    let page = context.pages()[0];
    if (options.onPageCreated) {
      const initial = page;
      context.once('page', () =>
        options.onPageCreated!({ at: new Date().toISOString(), monotonicMs: performance.now() }),
      );
      page = await context.newPage();
      await initial.close();
    }
    if (options.recordVideo && options.onPointerClick) {
      const onPointerClick = options.onPointerClick;
      await page.exposeBinding(
        '__recordReflexClick',
        (_source, x: number, y: number, at: number) => {
          onPointerClick({
            x,
            y,
            at: new Date(at).toISOString(),
            monotonicMs: at - performance.timeOrigin,
          });
        },
      );
      await page.addInitScript(() => {
        const record = Reflect.get(window, '__recordReflexClick');
        window.addEventListener(
          'pointerdown',
          (event) => {
            if (event.isTrusted)
              void record(event.clientX, event.clientY, performance.timeOrigin + event.timeStamp);
          },
          { capture: true, passive: true },
        );
      });
    }
    await page.goto(new URL(options.pagePath ?? '/?session=' + name, origin).href);
    const reader = options.readerPath === false ? page : await context.newPage();
    if (options.readerPath !== false)
      await reader.goto(new URL(options.readerPath ?? '/__records', origin).href);
    const output = join(directory, name + '-mcp');
    await mkdir(output, { recursive: true });
    const upstream = await createConnection(
      { snapshot: { mode: 'full' }, outputDir: output, timeouts: { settle: settleMs } },
      async () =>
        context as unknown as Awaited<
          ReturnType<NonNullable<Parameters<typeof createConnection>[1]>>
        >,
    );
    const [server, transport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(server);
    const client = new Client({ name: 'reflexrun-live-browser', version: '0.3.0' });
    await client.connect(transport);
    const port: ToolPort = {
      listTools: () => client.listTools(),
      callTool: async (call) => (await client.callTool(call)) as CallToolResult,
    };
    await port.callTool({ name: 'browser_snapshot', arguments: {} });
    await port.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } });
    const cdpPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    return new LiveBrowser(
      context,
      page,
      reader,
      client,
      upstream,
      port,
      page.url(),
      profile,
      'http://127.0.0.1:' + cdpPort,
    );
  }
  async tools(names = ['browser_snapshot', 'browser_type', 'browser_press_key', 'browser_click']) {
    return (await this.port.listTools()).tools.filter((tool) => names.includes(tool.name));
  }
  async records(): Promise<Todo[]> {
    this.reads++;
    return this.reader.evaluate(() =>
      Object.values(localStorage).flatMap((value) => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed)
            ? parsed.filter(
                (row) =>
                  row &&
                  typeof row.id === 'string' &&
                  typeof row.title === 'string' &&
                  typeof row.completed === 'boolean',
              )
            : [];
        } catch {
          return [];
        }
      }),
    );
  }
  async verify(title: string, budgetMs = contract.timeoutMs) {
    const at = performance.now();
    let records: Todo[] = [],
      reason = 'Missing write';
    try {
      do {
        records = await this.records();
        const result = exactNewTodo(this.baseline, records, title);
        if (new URL(this.page.url()).origin !== new URL(this.url).origin)
          return {
            status: 'rejected' as const,
            source: contract.source,
            reason: 'Execution left its authorized origin',
          };
        if (result.confirmed) {
          this.baseline = records;
          return { status: 'confirmed' as const, source: contract.source };
        }
        reason = result.reason;
        if (result.terminal) break;
        if (performance.now() - at >= budgetMs) break;
        await new Promise((done) =>
          setTimeout(done, Math.min(contract.pollMs, budgetMs - (performance.now() - at))),
        );
      } while (performance.now() - at < budgetMs);
      return { status: 'rejected' as const, source: contract.source, reason };
    } finally {
      this.verificationMs += performance.now() - at;
    }
  }
  async faultCases(run: (title: string) => Promise<any>, prefix: string) {
    const snapshot = await this.reader.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    const baseline = structuredClone(this.baseline),
      rows = [];
    for (const kind of ['drop', 'wrong']) {
      const title = `${prefix}-${kind}`;
      await this.page.evaluate(
        `(() => { window.__storageFaultAttempts = 0; const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { let data; try {data = JSON.parse(value);} catch {} if (Array.isArray(data) && data.some(row => row && row.title === ${JSON.stringify(title)})) { window.__storageFaultAttempts++; if (${JSON.stringify(kind)} === 'drop') return; data = data.map(row => row.title === ${JSON.stringify(title)} ? {...row, title: row.title + '-WRONG'} : row); return original.call(this, key, JSON.stringify(data)); } return original.call(this, key, value); }; })()`,
      );
      const started = performance.now(),
        native = await run(title);
      const common = await this.verify(
        title,
        Math.max(0, contract.timeoutMs - (native.verificationMs ?? 0)),
      );
      const writesAttempted = await this.page.evaluate(
        () => (window as any).__storageFaultAttempts,
      );
      rows.push({
        kind,
        title,
        native,
        common,
        writesAttempted,
        exercised: writesAttempted > 0,
        records: await this.records(),
        elapsedMs: Math.round(performance.now() - started),
      });
      // Evaluator-only reset between negative cases. Neither model nor replay tools can invoke it.
      await this.page.evaluate((snapshot) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
      }, snapshot);
      await this.page.reload();
      this.baseline = structuredClone(baseline);
    }
    return {
      rows,
      setup:
        'Original app storage is snapshotted after the genuine cold run, then restored by the evaluator only between isolated negative cases; resets are excluded from action/success/timing claims.',
    };
  }
  async renameInput() {
    const input = this.page.getByRole('textbox');
    if ((await input.count()) !== 1)
      throw new Error('The drift fixture requires one visible textbox');
    const selector = await input.evaluate(
      (element) =>
        `${element.tagName.toLowerCase()}[placeholder=${JSON.stringify(element.getAttribute('placeholder'))}]`,
    );
    // A source string keeps the browser fixture independent of tsx's function-name helpers.
    const script = `(() => { const selector = ${JSON.stringify(selector)}; const name = 'Add the next task'; const apply = () => { const element = document.querySelector(selector); if (element) { element.setAttribute('placeholder', name); element.setAttribute('aria-label', name); } }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, {once:true}); else apply(); })()`;
    await this.context.addInitScript({ content: script });
    await this.page.evaluate(script);
  }
  async selectors(call: { name: string; arguments: Record<string, any> }) {
    const state = fromPlaywrightSnapshot(
      plain(await this.port.callTool({ name: 'browser_snapshot', arguments: {} })),
    );
    const args = structuredClone(call.arguments),
      ref = args.target ?? args.ref;
    if (ref) {
      const element = state.elements.find((element) => element.ref === ref);
      if (!element) throw new Error('Unknown live snapshot ref');
      let target = this.page.getByRole(element.role as any, { name: element.name, exact: true });
      if (element.locator.index !== undefined) target = target.nth(element.locator.index);
      if ((await target.count()) !== 1)
        throw new Error('Cannot translate an ambiguous native target');
      args.target = await target.evaluate((element) => {
        for (const attribute of ['id', 'placeholder', 'aria-label', 'name']) {
          const value = element.getAttribute(attribute);
          if (!value) continue;
          const selector = `${element.tagName.toLowerCase()}[${attribute}=${JSON.stringify(value)}]`;
          if (document.querySelectorAll(selector).length === 1) return selector;
        }
        throw new Error('No unique visible-attribute selector');
      });
      delete args.ref;
    }
    return { name: call.name, arguments: args };
  }
  async shot(path: string) {
    await this.page.screenshot({ path });
  }
  async close() {
    await this.client.close();
    await this.upstream.close();
    await this.context.close();
  }
}

export async function freshEvaluationDirectory(evidence?: string) {
  const parent = evidence === undefined ? tmpdir() : resolve(evidence);
  if (evidence !== undefined) await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(
    join(parent, evidence === undefined ? 'reflex-live-eval-' : 'run-'),
  );
  await mkdir(join(directory, 'model-cwd'));
  return directory;
}

/** Record tool versions and persisted workflow evidence for the live run. */
export async function finalizeLiveEvidence(report: Record<string, any>) {
  report.frameworks = {
    codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
    playwrightMcp: JSON.parse(
      await readFile(resolve('node_modules/@playwright/mcp/package.json'), 'utf8'),
    ).version,
  };
  report.allMethodsSucceeded = report.validationPassed;
  delete report.validationPassed;
  report.summary = {};
  const result = report.results.reflex;
  if (!result) return report;

  const store = new ExperienceStore(join(report.directory, 'reflex-memory'));
  if (result.persistedAfterRestart) {
    result.freshStoreReadback = result.persistedAfterRestart;
    delete result.persistedAfterRestart;
  }
  result.learnedExperiences = await store.list();
  result.versions = await store.versions();
  const rows = result.phases.at(-1)?.result.rows ?? [];
  const confirmed = rows.filter((row: any) => row.status === 'confirmed').length;
  report.summary.reflex = {
    requested: report.items,
    confirmed,
    rejected: rows.filter((row: any) => row.status === 'rejected').length,
    notAttempted: Math.max(0, report.items - rows.length),
    modelRepairTurns: report.modelRuns.filter(
      (run: any) => run.method === 'reflex' && run.phase === 'repair',
    ).length,
    batchMs: result.phases.reduce((sum: number, phase: any) => sum + phase.elapsedMs, 0),
    nativeCompleted: confirmed,
    faultCasesExercised: result.faults?.rows.filter((row: any) => row.exercised).length ?? 0,
    faultFalseAccepts:
      result.faults?.rows.filter((row: any) => row.exercised && row.common.status === 'confirmed')
        .length ?? 0,
  };
  return report;
}

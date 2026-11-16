import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createToolProxyServer } from '../src/proxy/server.js';
import {
  fromPlaywrightSnapshot,
  PlaywrightMcpHost,
  type ProxyTiming,
} from '../src/proxy/playwright.js';
import { ToolProxy } from '../src/proxy/index.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { unmappedApp } from './fixtures/unmapped.js';

const plain = (result: CallToolResult) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

test('Native YAML quoted nodes preserve refs, names and nested structure', () => {
  const state = fromPlaywrightSnapshot(`- Page URL: https://fixture.example.test/
### Snapshot
\`\`\`yaml
- 'group "Step: two" [ref=e1]':
  - 'button "Next: role details →" [ref=e19] [cursor=pointer]'
  - 'button "Don''t: submit" [ref=e20]'
  - "button \\"Download: PDF\\" [ref=e21]"
\`\`\``);
  assert.deepEqual(
    state.elements.map(({ ref, name }) => [ref, name]),
    [
      ['e1', 'Step: two'],
      ['e19', 'Next: role details →'],
      ['e20', "Don't: submit"],
      ['e21', 'Download: PDF'],
    ],
  );
});

test('A full snapshot beginning with a quoted node is usable without a fallback read', async () => {
  let reads = 0;
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      reads++;
      return {
        content: [
          {
            type: 'text',
            text: '- Page URL: https://fixture.example.test/\n### Snapshot\n- \'button "Save: draft" [ref=e1]\'',
          },
        ],
      };
    },
  });
  assert.equal((await host.observe()).elements[0]?.name, 'Save: draft');
  await host.observe();
  assert.equal(reads, 1);
});

test('A linked action snapshot refreshes through the original native snapshot tool', async () => {
  let snapshots = 0;
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async (call) => ({
      content: [
        {
          type: 'text',
          text:
            call.name === 'browser_snapshot'
              ? `- Page URL: https://fixture.example.test/\n### Snapshot\n\`\`\`yaml\n- button "${++snapshots === 1 ? 'Open order' : 'Download invoice'}" [ref=e${snapshots}]\n\`\`\``
              : '- Page URL: https://fixture.example.test/\n### Snapshot\n- [Snapshot](browser-snapshot.yml)',
        },
      ],
    }),
  });
  assert.equal((await host.observe()).elements[0].name, 'Open order');
  await host.forward({ name: 'browser_click', arguments: { ref: 'e1' } });
  assert.equal((await host.observe()).elements[0]?.name, 'Download invoice');
  assert.equal(snapshots, 2, 'The link must not be accepted as an empty inline snapshot');
  await host.observe();
  assert.equal(snapshots, 2, 'A full snapshot remains cached normally');
});

test('An upstream link-only refresh cannot return a stale or empty page', async () => {
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({
      content: [{ type: 'text', text: '### Snapshot\n- [Snapshot](browser-snapshot.yml)' }],
    }),
  });
  await assert.rejects(host.observe(), /usable.*snapshot/i);
});

test('A genuine empty inline snapshot is still a usable page', async () => {
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({
      content: [
        {
          type: 'text',
          text: '- Page URL: https://fixture.example.test/\n### Snapshot\n```yaml\n\n```',
        },
      ],
    }),
  });
  const state = await host.observe();
  assert.equal(state.scope, 'https://fixture.example.test');
  assert.deepEqual(state.elements, []);
});

test('Replay target readiness reads immediately and waits only while the target is ambiguous', async () => {
  let reads = 0;
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({
      content: [
        {
          type: 'text',
          text: [
            '- Page URL: https://fixture.example.test/',
            '### Snapshot',
            '- button "Next" [ref=e1]',
            ...(++reads === 2 ? ['- button "Next" [ref=e2]'] : []),
          ].join('\n'),
        },
      ],
    }),
  });
  const unique = (state: Awaited<ReturnType<typeof host.observe>>) =>
    state.elements.filter((element) => element.name === 'Next').length === 1;
  await host.observeUntil(unique, { kind: 'click' });
  assert.equal(reads, 1);
  const result = await host.observeUntil(unique, { kind: 'click' });
  assert.equal(reads, 3);
  assert.equal(result.elements[0].ref, 'e1');
});

test('A new route gets one bounded editor settle and a fresh target after it', async () => {
  let url = '/',
    reads = 0;
  const host = new PlaywrightMcpHost({
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({
      content: [
        {
          type: 'text',
          text: `- Page URL: https://fixture.example.test${url}\n### Snapshot\n- textbox "Details" [ref=e${++reads}]`,
        },
      ],
    }),
  });
  await host.observe();
  url = '/editor';
  const start = performance.now();
  const editor = await host.observeUntil((state) => state.elements.length === 1, { kind: 'fill' });
  assert.ok(
    performance.now() - start >= 240,
    'An immediate visible editor cannot prove write readiness',
  );
  assert.notEqual(editor.elements[0].ref, 'e2', 'Resolve the target again after settling');
  const afterTransition = reads;
  await host.observeUntil((state) => state.elements.length === 1, { kind: 'fill' });
  assert.equal(reads, afterTransition + 1, 'A second edit on this route proceeds immediately');
});

test('Consecutive replay writes share fresh transition observations and retain separate fences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-replay-transition-'));
  let stage = 0,
    failAfterOpen: 'scope' | 'snapshot' | undefined,
    repairs = 0;
  const calls: string[] = [];
  const host = new PlaywrightMcpHost({
    listTools: async () => ({
      tools: ['browser_snapshot', 'browser_click'].map((name) => ({
        name,
        inputSchema: { type: 'object' as const },
      })),
    }),
    callTool: async (call) => {
      calls.push(call.name);
      if (call.name === 'browser_click') {
        assert.equal(call.arguments.target, `e${stage + 1}`);
        stage++;
      }
      if (stage === 1 && failAfterOpen === 'snapshot' && call.name === 'browser_snapshot') {
        failAfterOpen = undefined;
        throw new Error('Transition snapshot unavailable');
      }
      if (stage === 1 && failAfterOpen === 'scope' && call.name === 'browser_click')
        return {
          content: [
            {
              type: 'text',
              text: '- Page URL: https://external.example.test/\n### Snapshot\n- button "Save" [ref=e2]',
            },
          ],
        };
      const view =
        call.name === 'browser_snapshot'
          ? ['- button "Open" [ref=e1]', '- button "Save" [ref=e2]', '- status: Saved'][stage]
          : '- [Snapshot](native-snapshot.yml)';
      return {
        content: [
          {
            type: 'text',
            text: '- Page URL: https://fixture.example.test/\n### Snapshot\n' + view,
          },
        ],
      };
    },
  });
  try {
    await host.initialize();
    const runner = new Reflex({
      host,
      store: new ExperienceStore(directory),
      explore: async ({ tools }) => {
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Open' }, effect: true });
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Save' }, effect: true });
        return { goal: { text: 'Saved' } };
      },
      repair: async () => {
        repairs++;
        return null;
      },
    });
    const task = {
      key: 'save-record',
      inputs: {},
      verification: 'readback' as const,
      readback: async () => ({
        status: stage === 2 ? ('confirmed' as const) : ('rejected' as const),
        source: 'Independent fixture record',
      }),
    };
    assert.equal((await runner.run({ ...task, job: 'learn' })).status, 'completed');
    stage = 0;
    await host.observe({ fresh: true });
    calls.length = 0;
    const fenced: string[] = [];
    const result = await runner.run({
      ...task,
      job: 'replay',
      beforeEffect: (action) => {
        fenced.push(action.target!.name!);
        return true;
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.source, 'memory');
    assert.equal(result.effectAttempts, 2);
    assert.deepEqual(fenced, ['Open', 'Open', 'Save', 'Save']);
    assert.deepEqual(calls, [
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
    ]);
    for (const failure of ['scope', 'snapshot'] as const) {
      stage = 0;
      await host.observe({ fresh: true });
      calls.length = 0;
      failAfterOpen = failure;
      const result = await runner.run({ ...task, job: failure });
      assert.equal(result.status, 'uncertain');
      assert.equal(result.effectAttempts, 1);
      assert.match(
        result.error ?? '',
        failure === 'scope' ? /authorized scope/ : /snapshot unavailable/,
      );
      assert.equal(repairs, 0, 'A failed observation after dispatch must never trigger repair');
      assert.equal(calls.filter((name) => name === 'browser_click').length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Proxy timing separates upstream, parsing and authorization without weakening denial', async () => {
  const timings: ProxyTiming[] = [];
  let writes = 0,
    denied = false;
  const host = new PlaywrightMcpHost(
    {
      listTools: async () => ({
        tools: ['browser_snapshot', 'browser_click'].map((name) => ({
          name,
          inputSchema: { type: 'object' as const },
        })),
      }),
      callTool: async (call) => {
        if (call.name === 'browser_click') writes++;
        return {
          content: [
            {
              type: 'text',
              text: '- Page URL: https://fixture.example.test/\n- Page Title: Timing\n### Snapshot\n- button "Save" [ref=e1]',
            },
          ],
        };
      },
    },
    () => !denied,
    { onTiming: (event) => timings.push(event) },
  );
  await host.initialize();
  await host.observe();
  const action = await host.translate({ name: 'browser_click', arguments: { target: 'e1' } });
  assert.equal(await host.authorizeEffect(action), true);
  await host.act(action);
  assert.equal(writes, 1);
  denied = true;
  await assert.rejects(
    host.forward({ name: 'browser_click', arguments: { target: 'e1' } }),
    /denied/,
  );
  assert.equal(writes, 1);
  for (const stage of ['upstream', 'parse', 'authorization', 'translate'])
    assert.ok(
      timings.some((event) => event.stage === stage),
      stage,
    );
  for (const event of timings) {
    assert.ok(event.elapsedMs >= 0);
    assert.equal(event.elapsedMs, event.endedMs - event.startedMs);
    assert.equal(event.inclusive, event.stage === 'translate');
  }
});

test(
  'The real Playwright MCP protocol survives the proxy: refs, bulk form, select, frame, tabs, upload, cookies and replay',
  { timeout: 40_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-native-protocol-')),
      app = await unmappedApp();
    const browser = await chromium.launch(),
      context = await browser.newContext();
    await context.addCookies([
      { name: 'fixture-session', value: 'synthetic-authorized-session', url: app.origin },
    ]);
    const original = await context.newPage();
    await original.goto(app.origin + '/intake');
    const unrelated = await context.newPage();
    await unrelated.goto(app.origin + '/help');
    // This is the actual upstream package, connected to the already existing context.
    const upstream = await createConnection(
      { snapshot: { mode: 'full' }, outputDir: directory },
      async () =>
        context as unknown as Awaited<
          ReturnType<NonNullable<Parameters<typeof createConnection>[1]>>
        >,
    );
    const [upstreamServer, upstreamClient] = InMemoryTransport.createLinkedPair();
    await upstream.connect(upstreamServer);
    const native = new Client({ name: 'upstream-client', version: 'test' });
    await native.connect(upstreamClient);
    const forwarded: { name: string; arguments: unknown }[] = [];
    let lastUpstream: CallToolResult | undefined,
      denySubmit = false,
      submitAuthorizations = 0;
    let unblockSave = () => {};
    const port = {
      listTools: () => native.listTools(),
      callTool: async (call: { name: string; arguments: Record<string, unknown> }) => {
        forwarded.push(structuredClone(call));
        return (lastUpstream = (await native.callTool(call)) as CallToolResult);
      },
    };
    const { server, proxy } = await createToolProxyServer(
      port,
      join(directory, 'memory'),
      (call, phase) => {
        if (call.name === 'browser_click' && call.arguments.element === 'Submit request') {
          submitAuthorizations++;
          return !(denySubmit && phase === 'replay');
        }
        return true;
      },
    );
    const [proxyServer, proxyClient] = InMemoryTransport.createLinkedPair();
    await server.connect(proxyServer);
    const client = new Client({ name: 'unchanged-original-agent', version: 'test' });
    await client.connect(proxyClient);
    const ask = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      assert.ok(!r.isError, plain(r));
      return r;
    };
    const meta = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(plain(await ask(name, args)));
    const snapshot = async () => fromPlaywrightSnapshot(plain(await ask('browser_snapshot', {})));
    try {
      const offered = (await client.listTools()).tools;
      for (const tool of (await native.listTools()).tools)
        assert.deepEqual(
          offered.find((t) => t.name === tool.name),
          tool,
        );
      assert.equal(
        offered.find((tool) => tool.name === 'reflex_wait')?.annotations?.readOnlyHint,
        true,
      );
      const firstFile = join(directory, 'first.txt'),
        secondFile = join(directory, 'second.txt');
      await writeFile(firstFile, 'Synthetic first file');
      await writeFile(secondFile, 'Synthetic second file');
      // Choose the existing first tab; no replacement browser/context/page is created by the proxy.
      await ask('browser_snapshot', {}); // Initialize the upstream's lazy attachment to its existing context.
      await ask('browser_tabs', { action: 'select', index: 0 });
      const first = {
        name: 'Native first',
        email: 'native-first@example.test',
        topic: ['sport'],
        updates: false,
        frame: 'First frame value',
        files: [firstFile],
      };
      assert.equal(
        (await meta('reflex_begin', { key: 'native-protocol-form', job: 'first', inputs: first }))
          .mode,
        'explore',
      );
      let state = await snapshot();
      const ref = (name: string) => state.elements.find((e) => e.name === name)!.ref;
      const formCall = {
        fields: [
          { target: ref('Full name'), name: 'Full name', type: 'textbox', value: first.name },
          {
            target: ref('Contact email'),
            name: 'Contact email',
            type: 'textbox',
            value: first.email,
          },
          {
            target: ref('Receive updates'),
            name: 'Receive updates',
            type: 'checkbox',
            value: 'false',
          },
        ],
      };
      await ask('browser_fill_form', formCall);
      assert.deepEqual(
        forwarded.filter((c) => c.name === 'browser_fill_form').at(-1)!.arguments,
        formCall,
      );
      state = await snapshot();
      await ask('browser_select_option', { target: ref('Topic'), values: first.topic });
      state = await snapshot();
      await ask('browser_type', { target: ref('Frame note'), text: first.frame });
      state = await snapshot();
      await ask('browser_click', { target: ref('Attachment') });
      await ask('browser_file_upload', { paths: first.files });
      await ask('browser_tabs', { action: 'new', url: app.origin + '/help?task-tab=1' });
      await ask('browser_tabs', { action: 'close' });
      await ask('browser_tabs', { action: 'select', index: 0 });
      state = await snapshot();
      await ask('browser_click', { target: ref('Submit request'), element: 'Submit request' });
      assert.equal(
        app.saves.length,
        1,
        JSON.stringify({
          urls: context.pages().map((p) => p.url()),
          originalClosed: original.isClosed(),
          values: !original.isClosed()
            ? await original.locator('input').evaluateAll((xs) =>
                xs.map((el) => {
                  const x = el as HTMLInputElement;
                  return { name: x.name, value: x.value, valid: x.validity.valid };
                }),
              )
            : [],
        }),
      );
      let enterSave!: () => void;
      const saveEntered = new Promise<void>((resolve) => {
        enterSave = resolve;
      });
      const saveReleased = new Promise<void>((resolve) => {
        unblockSave = resolve;
      });
      const originalSave = proxy.store.save.bind(proxy.store);
      proxy.store.save = async (memory) => {
        enterSave();
        await saveReleased;
        await originalSave(memory);
      };
      const learned = await meta('reflex_finish', { goal: { text: 'Request received' } });
      assert.equal(learned.result.learning, 'pending');
      await saveEntered;
      const firstLearning = proxy.waitForLearning();
      assert.equal(learned.result.status, 'completed', learned.result.error);
      assert.equal(app.saves.at(-1)!.attachment, 'first.txt');
      assert.equal(context.pages().length, 2);
      app.state.prefix = true;
      const second = {
        name: 'Native second',
        email: 'native-second@example.test',
        topic: ['music'],
        updates: true,
        frame: 'Second frame value',
        files: [secondFile],
      };
      let warmSettled = false;
      const warmPending = meta('reflex_begin', {
        key: 'native-protocol-form',
        job: 'second',
        inputs: second,
      }).then((notice) => {
        warmSettled = true;
        return notice;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(warmSettled, false, 'The next task must await pending experience persistence');
      unblockSave();
      const warm = await warmPending;
      const firstReady = await firstLearning;
      assert.equal(firstReady?.learning, 'ready');
      assert.ok(firstReady?.timings?.memoryReadyMs !== undefined);
      proxy.store.save = originalSave;
      const learnedFinal = await meta('reflex_wait', {});
      assert.equal(learnedFinal.status, 'completed');
      assert.ok(learnedFinal.timings.taskReadyMs !== undefined);
      assert.equal(warm.mode, 'done', JSON.stringify(warm));
      assert.equal(warm.result.status, 'completed', warm.result.error);
      assert.equal(warm.result.hostDelegations, 0);
      assert.equal(app.saves.at(-1)!.name, second.name);
      assert.equal(app.saves.at(-1)!.topic, 'music');
      assert.equal(app.saves.at(-1)!.updates, 'on');
      assert.equal(app.saves.at(-1)!.attachment, 'second.txt');
      assert.equal(context.pages().length, 2);
      assert.equal(context.pages()[0], original);
      assert.equal(context.pages()[1], unrelated);
      assert.ok(
        (await context.cookies(app.origin)).some(
          (c) => c.name === 'fixture-session' && c.value === 'synthetic-authorized-session',
        ),
      );
      assert.equal(proxy.host.id, 'playwright-mcp-proxy');
      assert.equal(
        submitAuthorizations,
        2,
        'Persistence fences must not repeat the original host authorization prompt',
      );
      denySubmit = true;
      const blocked = await meta('reflex_begin', {
        key: 'native-protocol-form',
        job: 'denied',
        inputs: { ...second, name: 'Denied fixture' },
      });
      assert.equal(blocked.result.status, 'uncertain');
      assert.equal(app.saves.length, 2);
      assert.equal(submitAuthorizations, 3);
      let liveFences = 0;
      const callerBlocked = await proxy.begin({
        key: 'native-protocol-form',
        job: 'caller-denied',
        inputs: second,
        beforeEffect: () => {
          liveFences++;
          return false;
        },
      });
      assert.equal(callerBlocked.mode, 'done');
      assert.equal(liveFences, 1);
      assert.equal(app.saves.length, 2, 'The proxy must retain the calling host policy fence');
      const raw = await ask('browser_evaluate', { function: '() => document.title' });
      assert.deepEqual(
        raw,
        lastUpstream,
        'Unrecorded native tools keep the exact upstream response',
      );
      state = await snapshot();
      await ask('browser_click', { target: ref('Attachment') });
      const refusedFile = (await client.callTool({
        name: 'browser_file_upload',
        arguments: { paths: ['/not-granted-reflex-fixture.txt'] },
      })) as CallToolResult;
      assert.equal(refusedFile.isError, true);
      assert.deepEqual(refusedFile, lastUpstream);
      await ask('browser_file_upload', {});
      const miss = await meta('reflex_begin', {
        key: 'unsupported-capture',
        job: 'unsupported',
        inputs: {},
      });
      assert.equal(miss.mode, 'explore');
      const stillNative = await ask('browser_evaluate', { function: '() => document.title' });
      assert.deepEqual(stillNative, lastUpstream);
      assert.equal(
        (await meta('reflex_finish', { goal: { text: 'Community workshop request' } })).mode,
        'unlearned',
      );
    } finally {
      proxy.cancel();
      unblockSave();
      await proxy.waitForLearning();
      await client.close();
      await server.close();
      await native.close();
      await upstream.close();
      await browser.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'The shipped stdio proxy reconnects official Playwright MCP to an existing CDP browser without replacing its session',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-cli-')),
      app = await unmappedApp();
    const profile = join(directory, 'browser-profile');
    const context = await chromium.launchPersistentContext(profile, {
      args: ['--remote-debugging-port=0'],
    });
    const original = context.pages()[0];
    await original.goto(app.origin + '/intake');
    await context.addCookies([{ name: 'existing-login', value: 'synthetic', url: app.origin }]);
    const port = Number(
      (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        'src/cli.ts',
        'proxy',
        '--memory',
        join(directory, 'memory'),
        '--',
        process.execPath,
        'node_modules/@playwright/mcp/cli.js',
        '--cdp-endpoint',
        `http://127.0.0.1:${port}`,
        '--output-dir',
        directory,
      ],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    const client = new Client({ name: 'proxy-cli-test', version: 'test' });
    try {
      await client.connect(transport);
      const ask = async (name: string, args: Record<string, unknown>) => {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
        assert.ok(!result.isError, plain(result) + stderr);
        return result;
      };
      const meta = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(plain(await ask(name, args)));
      await ask('browser_snapshot', {});
      assert.equal(
        (
          await meta('reflex_begin', {
            key: 'cli-fill',
            job: 'cold',
            inputs: { name: 'CDP first' },
          })
        ).mode,
        'explore',
      );
      const state = fromPlaywrightSnapshot(plain(await ask('browser_snapshot', {})));
      await ask('browser_type', {
        target: state.elements.find((e) => e.name === 'Full name')!.ref,
        text: 'CDP first',
      });
      const learned = await meta('reflex_finish', {
        goal: { target: { role: 'textbox', name: 'Full name' }, equals: 'CDP first' },
      });
      assert.equal(learned.result.status, 'completed', JSON.stringify(learned));
      const warm = await meta('reflex_begin', {
        key: 'cli-fill',
        job: 'warm',
        inputs: { name: 'CDP second' },
      });
      assert.equal(warm.result.status, 'completed', JSON.stringify(warm));
      assert.equal(warm.result.hostDelegations, 0);
      assert.equal(await original.getByLabel('Full name').inputValue(), 'CDP second');
      assert.equal(context.pages().length, 1);
      assert.ok(
        (await context.cookies()).some(
          (cookie) => cookie.name === 'existing-login' && cookie.value === 'synthetic',
        ),
      );
      await client.close();
      assert.equal(
        original.isClosed(),
        false,
        'Disconnecting the proxy must preserve the user-owned browser',
      );
    } finally {
      await client.close();
      await transport.close();
      await context.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('A failed background save is reported once and the proxy can learn a later task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-save-failure-'));
  let writes = 0;
  const snapshot = (): CallToolResult => ({
    content: [
      {
        type: 'text',
        text: `- Page URL: https://fixture.example.test/\n- Page Title: Save fixture\n### Snapshot\n- button "Save" [ref=e1]\n- status: ${writes ? 'Saved' : 'Ready'}`,
      },
    ],
  });
  const store = new ExperienceStore(directory);
  const proxy = new ToolProxy(
    {
      listTools: async () => ({
        tools: ['browser_snapshot', 'browser_click'].map((name) => ({
          name,
          inputSchema: { type: 'object' as const, properties: {} },
        })),
      }),
      callTool: async (call) => {
        if (call.name === 'browser_click') writes++;
        return snapshot();
      },
    },
    store,
  );
  try {
    await proxy.host.initialize();
    assert.equal(await proxy.waitForLearning(), undefined);
    const save = store.save.bind(store);
    store.save = async () => {
      throw new Error('Memory write denied');
    };
    assert.equal((await proxy.begin({ key: 'save', job: 'first', inputs: {} })).mode, 'explore');
    await proxy.call({ name: 'browser_click', arguments: { target: 'e1' } });
    const complete = await proxy.finish({ text: 'Saved' });
    assert.equal(complete.mode, 'done');
    const result = await proxy.waitForLearning();
    assert.equal(result?.status, 'completed');
    assert.equal(result?.learning, 'failed');
    assert.match(result?.learningError ?? '', /write denied/);
    await assert.rejects(
      proxy.begin({ key: 'save', job: 'next', inputs: {} }),
      /experience was not ready/,
    );
    assert.equal(writes, 1, 'Reporting failed learning must never retry the business write');
    store.save = save;
    assert.equal(
      (await proxy.begin({ key: 'save', job: 'retry-learning', inputs: {} })).mode,
      'explore',
    );
    await proxy.call({ name: 'browser_click', arguments: { target: 'e1' } });
    await proxy.finish({ text: 'Saved' });
    assert.equal((await proxy.waitForLearning())?.learning, 'ready');
    assert.equal(writes, 2);
  } finally {
    proxy.cancel();
    await proxy.waitForLearning();
    await rm(directory, { recursive: true, force: true });
  }
});

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
}

for (const stage of ['translation', 'dispatch'] as const)
  test(`Cancel and restart waits for the old native ${stage} call`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-cancel-'));
    const entered = gate(),
      resume = gate();
    let writes = 0;
    const snapshot = (): CallToolResult => ({
      content: [
        {
          type: 'text',
          text: `- Page URL: https://fixture.example.test/\n- Page Title: Save fixture\n### Snapshot\n- button "Save" [ref=e1]\n- status: ${writes ? 'Saved' : 'Ready'}`,
        },
      ],
    });
    const proxy = new ToolProxy(
      {
        listTools: async () => ({
          tools: ['browser_snapshot', 'browser_click'].map((name) => ({
            name,
            inputSchema: { type: 'object' as const, properties: {} },
          })),
        }),
        callTool: async (call) => {
          if (call.name === 'browser_click') {
            if (stage === 'dispatch') {
              entered.release();
              await resume.promise;
            }
            writes++;
          }
          return snapshot();
        },
      },
      new ExperienceStore(directory),
    );
    const translate = proxy.host.translate.bind(proxy.host);
    if (stage === 'translation')
      proxy.host.translate = async (call) => {
        entered.release();
        await resume.promise;
        return translate(call);
      };
    await proxy.host.initialize();
    assert.equal((await proxy.begin({ key: 'save', job: 'old', inputs: {} })).mode, 'explore');
    const call = proxy.call({ name: 'browser_click', arguments: { target: 'e1' } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    let restarted: Promise<Awaited<ReturnType<ToolProxy['begin']>>> | undefined;
    try {
      await entered.promise;
      const canceled = proxy.cancel();
      let settled = false;
      restarted = proxy.begin({ key: 'save', job: 'new', inputs: {} });
      void restarted.then(
        () => (settled = true),
        () => (settled = true),
      );
      await delay(30);
      assert.equal(settled, false, 'The next task must wait for the whole native call');
      assert.equal(writes, 0);
      resume.release();
      const callError = await call;
      await canceled;
      assert.equal((await restarted).mode, 'explore');
      assert.equal(writes, stage === 'dispatch' ? 1 : 0);
      if (stage === 'translation') assert.ok(callError instanceof Error);
      else assert.equal(callError, undefined);
    } finally {
      resume.release();
      await call;
      await restarted?.catch(() => {});
      await proxy.cancel();
      await proxy.waitForLearning();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('The MCP cancellation hook allows a later task on the same proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-cancel-mcp-'));
  const { server, proxy } = await createToolProxyServer(
    {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        content: [
          {
            type: 'text',
            text: '- Page URL: https://fixture.example.test/\n### Snapshot\n- button "Save" [ref=e1]',
          },
        ],
      }),
    },
    directory,
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'cancel-fixture', version: 'test' });
  await client.connect(clientTransport);
  const ask = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    assert.ok(!result.isError, plain(result));
    return JSON.parse(plain(result));
  };
  try {
    assert.equal(
      (await ask('reflex_begin', { key: 'save', job: 'one', inputs: {} })).mode,
      'explore',
    );
    assert.equal((await ask('reflex_cancel', {})).canceled, true);
    assert.equal(
      (await ask('reflex_begin', { key: 'save', job: 'two', inputs: {} })).mode,
      'explore',
    );
  } finally {
    await proxy.cancel();
    await proxy.waitForLearning();
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cancelSource of ['method', 'signal'] as const)
  test(`Cancel from ${cancelSource} drains preflight and prevents a late task start`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-start-cancel-'));
    const entered = gate(),
      resume = gate();
    const controller = new AbortController();
    let reads = 0,
      writes = 0;
    const proxy = new ToolProxy(
      {
        listTools: async () => ({ tools: [] }),
        callTool: async (call) => {
          if (call.name === 'browser_snapshot' && ++reads === 1) {
            entered.release();
            await resume.promise;
          } else if (call.name !== 'browser_snapshot') writes++;
          return {
            content: [
              {
                type: 'text',
                text: '- Page URL: https://fixture.example.test/\n### Snapshot\n- button "Save" [ref=e1]',
              },
            ],
          };
        },
      },
      new ExperienceStore(directory),
    );
    await proxy.host.initialize();
    const first = proxy
      .begin({ key: 'save', job: 'old-start', inputs: {}, signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let restarted: ReturnType<ToolProxy['begin']> | undefined;
    try {
      await entered.promise;
      await assert.rejects(
        proxy.begin({ key: 'save', job: 'parallel-start', inputs: {} }),
        /Another task is starting/,
      );
      if (cancelSource === 'signal') controller.abort();
      const cancellation = cancelSource === 'method' ? proxy.cancel() : proxy.waitForLearning();
      let settled = false;
      void cancellation.then(() => (settled = true));
      restarted = proxy.begin({ key: 'save', job: 'new-start', inputs: {} });
      await delay(30);
      assert.equal(settled, false, 'Cancellation must wait for the original preflight observation');
      resume.release();
      const error = await first;
      assert.ok(error instanceof Error);
      assert.match(error.message, /canceled before starting/i);
      await cancellation;
      assert.equal(writes, 0);
      assert.equal((await restarted).mode, 'explore');
    } finally {
      resume.release();
      await first;
      await restarted?.catch(() => {});
      await proxy.cancel();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('An already aborted task is rejected before preflight and an aborted session permits restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-proxy-signal-'));
  let calls = 0;
  const proxy = new ToolProxy(
    {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        calls++;
        return {
          content: [
            {
              type: 'text',
              text: '- Page URL: https://fixture.example.test/\n### Snapshot\n- button "Save" [ref=e1]',
            },
          ],
        };
      },
    },
    new ExperienceStore(directory),
  );
  const controller = new AbortController();
  controller.abort();
  try {
    await proxy.host.initialize();
    await assert.rejects(
      proxy.begin({ key: 'save', job: 'already-canceled', inputs: {}, signal: controller.signal }),
      /canceled before starting/i,
    );
    assert.equal(calls, 0);
    const live = new AbortController();
    assert.equal(
      (await proxy.begin({ key: 'save', job: 'live', inputs: {}, signal: live.signal })).mode,
      'explore',
    );
    live.abort();
    await proxy.waitForLearning();
    assert.equal((await proxy.begin({ key: 'save', job: 'next', inputs: {} })).mode, 'explore');
  } finally {
    await proxy.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

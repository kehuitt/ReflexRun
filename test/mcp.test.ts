import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unmappedApp } from './fixtures/unmapped.js';
import { marketApp } from './fixtures/market.js';

test(
  'The default MCP batch pauses once for 100 renamed buttons and promotes after one host audit',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-mcp-batch-repair-')),
      app = await marketApp();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli.ts', 'mcp', '--memory', join(directory, 'memory')],
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'batch-repair-fixture-agent', version: '1.0.0' });
    const ask = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse((r.content as { text: string }[])[0].text);
    };
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        'reflex_task',
        'reflex_observe',
        'reflex_act',
        'reflex_complete',
        'reflex_wait',
        'reflex_repair',
        'reflex_memories',
        'reflex_batch',
        'reflex_batch_policy',
        'reflex_settle_batch',
        'reflex_cancel',
      ])
        assert.ok(names.includes(name), name);
      for (const name of ['reflex_run', 'reflex_policy', 'reflex_stop', 'reflex_status'])
        assert.ok(!names.includes(name), `Retired tool is still registered: ${name}`);
      for (let i = 0; i < 17; i++) {
        const canceled = await ask('reflex_task', {
          url: app.origin + '/item/item-canceled',
          key: 'market-mcp',
          job: 'canceled-' + i,
          inputs: { id: 'item-canceled' },
        });
        assert.equal(canceled.mode, 'explore');
        await ask('reflex_cancel', { session: canceled.session });
      }
      assert.equal(app.writes.length, 0);
      const first = await ask('reflex_task', {
        url: app.origin + '/item/item-seed',
        key: 'market-mcp',
        job: 'seed',
        inputs: { id: 'item-seed' },
      });
      await ask('reflex_act', {
        session: first.session,
        action: {
          kind: 'click',
          target: {
            ref: first.observation.elements.find((e: { name: string }) => e.name === 'Apply').ref,
          },
        },
      });
      await ask('reflex_complete', {
        session: first.session,
        goal: { text: 'Application received' },
        factPlan: {
          identity: { pattern: 'Item ID: ([^\\n]+)', expected: { $input: 'id' } },
          fields: { price: { pattern: 'Price: (¥[0-9.]+)', parse: 'money' } },
        },
      });
      app.state.renamed = true;
      const queue = Array.from({ length: 100 }, (_, i) => ({
        id: 'item-' + i,
        label: 'Trial',
        facts: { price: 0 },
        inputs: { id: 'item-' + i },
      }));
      const paused = await ask('reflex_batch', {
        url: app.origin + '/item/item-0',
        id: 'hundred-mcp',
        operation: 'market-mcp',
        items: queue,
        policy: { revision: 1, rules: [{ field: 'price', op: 'eq', value: 0 }] },
      });
      assert.equal(paused.mode, 'repair');
      const resumed = await ask('reflex_repair', {
        session: paused.session,
        actions: [
          {
            kind: 'click',
            target: {
              ref: paused.observation.elements.find(
                (e: { name: string }) => e.name === 'Join trial',
              ).ref,
            },
          },
        ],
      });
      assert.equal(resumed.mode, 'done');
      assert.equal(resumed.rows.length, 100);
      assert.ok(resumed.rows.every((r: { status: string }) => r.status === 'attempted'));
      assert.equal((await ask('reflex_memories', {})).length, 1);
      assert.equal(app.writes.length, 101);
      const settled = await ask('reflex_settle_batch', {
        id: 'hundred-mcp',
        source: 'Independent fixture write oracle',
        outcomes: queue.map((r) => ({ id: r.id, status: 'confirmed' })),
      });
      assert.equal(settled.candidates[0].status, 'promoted');
      assert.equal((await ask('reflex_memories', {})).length, 2);
    } finally {
      await client.close();
      await transport.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'MCP learns without a site contract, survives process restart, repairs drift and settles a whole queue',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reflex-mcp-memory-')),
      app = await unmappedApp();
    const open = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/cli.ts', 'mcp', '--memory', join(directory, 'memory')],
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'original-agent-fixture', version: '1.0.0' });
      await client.connect(transport);
      return {
        client,
        transport,
        async call(name: string, args: Record<string, unknown>) {
          const output = await client.callTool({ name, arguments: args });
          assert.ok(!output.isError, JSON.stringify(output));
          return JSON.parse((output.content as { text: string }[])[0].text);
        },
        async close() {
          await client.close();
          await transport.close();
        },
      };
    };
    let host = await open();
    const inputs = (name: string) => ({
      name,
      email: name.replace(/ /g, '').toLowerCase() + '@example.test',
      topic: 'sport',
      extra: false,
      workspace: 'private-workspace-fixture',
    });
    const task = (name: string, job: string) => ({
      url: app.origin + '/intake',
      key: 'unmapped-mcp-form',
      job,
      inputs: inputs(name),
      guardInputs: ['workspace'],
    });
    try {
      const cold = await host.call('reflex_task', task('First process', 'cold'));
      assert.equal(cold.mode, 'explore');
      let state = cold.observation;
      for (const [label, kind, value] of [
        ['Full name', 'fill', inputs('First process').name],
        ['Contact email', 'fill', inputs('First process').email],
        ['Topic', 'select', 'sport'],
        ['Extra instructions', 'check', false],
        ['Submit request', 'click', undefined],
      ]) {
        const ref = state.elements.find(
          (e: { name: string; role: string }) =>
            e.name === label || (kind === 'select' && e.role === 'combobox'),
        ).ref;
        state = await host.call('reflex_act', {
          session: cold.session,
          action: { kind, target: { ref }, ...(value !== undefined ? { value } : {}) },
        });
      }
      const complete = await host.call('reflex_complete', {
        session: cold.session,
        goal: { text: 'Request received' },
      });
      assert.equal(complete.result.status, 'completed');
      const ready = await host.call('reflex_wait', { session: cold.session });
      assert.equal(ready.learning, 'ready');
      assert.ok(ready.timings.memoryReadyMs >= ready.timings.taskReadyMs);
      await host.close();
      host = await open(); // A new OS child process, not merely a new Store instance.
      const memories = await host.call('reflex_memories', { key: 'unmapped-mcp-form' });
      assert.equal(memories.length, 1);
      assert.deepEqual(memories[0].guardInputs, ['workspace']);
      assert.ok(!JSON.stringify(memories).includes(inputs('First process').workspace));
      const warm = await host.call('reflex_task', task('New process', 'warm'));
      assert.equal(warm.mode, 'done');
      assert.equal(warm.result.hostDelegations, 0);
      assert.equal(app.saves.at(-1)!.name, 'New process');
      app.state.renamed = true;
      const drift = await host.call('reflex_task', task('Changed page', 'repair'));
      assert.equal(drift.mode, 'repair');
      const ref = drift.observation.elements.find(
        (e: { name: string }) => e.name === 'Send request',
      ).ref;
      const repaired = await host.call('reflex_repair', {
        session: drift.session,
        actions: [{ kind: 'click', target: { ref } }],
      });
      assert.equal(repaired.result.status, 'completed');
      assert.equal(repaired.result.repairs, 1);
      const args = {
        url: app.origin + '/intake',
        id: 'queue',
        operation: 'unmapped-mcp-form',
        policy: { revision: 1, rules: [] },
        items: ['Queue first', 'Reject fixture', 'Queue last'].map((name, i) => ({
          id: String(i),
          label: name,
          facts: {},
          inputs: inputs(name),
        })),
      };
      const batch = await host.call('reflex_batch', args);
      assert.ok(batch.rows.every((r: { status: string }) => r.status === 'attempted'));
      assert.equal(app.saves.at(-1)!.name, 'Queue last');
      const settled = await host.call('reflex_settle_batch', {
        id: 'queue',
        source: 'Independent fixture backend oracle',
        outcomes: [
          { id: '0', status: 'confirmed' },
          { id: '1', status: 'rejected' },
          { id: '2', status: 'confirmed' },
        ],
      });
      assert.equal(settled.audits, 1);
      assert.deepEqual(
        settled.rows.map((r: { status: string }) => r.status),
        ['confirmed', 'rejected', 'confirmed'],
      );
      const count = app.saves.length;
      await host.call('reflex_batch', args);
      assert.equal(app.saves.length, count);
      app.state.renamed = false;
      const canceledBatch = await host.call('reflex_batch', {
        ...args,
        id: 'canceled-queue',
        items: [{ id: 'canceled', label: 'Canceled', facts: {}, inputs: inputs('Canceled') }],
      });
      assert.equal(canceledBatch.mode, 'repair');
      await host.call('reflex_cancel', { session: canceledBatch.session });
      const recovered = await host.call('reflex_task', {
        ...task('After cancellation', 'cancel-recovery'),
        key: 'cancel-recovery',
      });
      assert.equal(recovered.mode, 'explore');
      await host.call('reflex_cancel', { session: recovered.session });
      assert.equal(app.saves.length, count, 'Cancellation must not dispatch the pending repair');
    } finally {
      await host.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

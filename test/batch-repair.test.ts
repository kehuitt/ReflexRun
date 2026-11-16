import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { marketApp } from './fixtures/market.js';
import { BrowserHost } from '../src/memory/browser.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { runMemoryBatch, settleMemoryBatch } from '../src/memory/batch.js';
import { readRecord } from '../src/memory/readback.js';
import type { FactPlan, Verification } from '../src/memory/types.js';

let browser: Browser, app: Awaited<ReturnType<typeof marketApp>>, directory: string;
before(async () => {
  browser = await chromium.launch();
  app = await marketApp();
  directory = await mkdtemp(join(tmpdir(), 'reflex-batch-v3-'));
});
after(async () => {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
const factPlan: FactPlan = {
  identity: { pattern: 'Item ID: ([^\\n]+)', expected: { $input: 'id' } },
  fields: { price: { pattern: 'Price: (¥[0-9.]+)', parse: 'money' } },
};
const policy = { revision: 1, rules: [{ field: 'price', op: 'eq' as const, value: 0 }] };
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `item-${String(i).padStart(3, '0')}`,
    label: 'Trial',
    facts: { price: 0 },
    inputs: { id: `item-${String(i).padStart(3, '0')}` },
  }));

test('Independent record-page extraction checks identity, exact values and authorized scope', async () => {
  Object.assign(app.state, { price: 0, wrongIdentity: false });
  const page = await browser.newPage(),
    host = new BrowserHost(page);
  const template = {
    url: app.origin + '/item/record-001',
    identity: factPlan.identity!,
    fields: { price: { ...factPlan.fields.price, expected: 0 } },
  };
  try {
    assert.equal(
      (await readRecord(host, template, { id: 'record-001' }, [app.origin])).status,
      'confirmed',
    );
    app.state.price = 49;
    assert.equal(
      (await readRecord(host, template, { id: 'record-001' }, [app.origin])).status,
      'rejected',
    );
    app.state.wrongIdentity = true;
    assert.equal(
      (await readRecord(host, template, { id: 'record-001' }, [app.origin])).status,
      'unknown',
    );
    const url = page.url();
    await assert.rejects(
      readRecord(
        host,
        { ...template, url: 'https://not-authorized.example/record' },
        { id: 'record-001' },
        [app.origin],
      ),
      /authorized scope/,
    );
    assert.equal(page.url(), url, 'An unauthorized readback must not navigate');
  } finally {
    await page.close();
  }
});
async function seeded(name: string, page: Page) {
  Object.assign(app.state, { renamed: false, optimistic: false, wrongIdentity: false, price: 0 });
  const store = new ExperienceStore(join(directory, name));
  await page.goto(app.origin + '/item/item-seed');
  const reflex = new Reflex({
    host: new BrowserHost(page),
    store,
    explore: async ({ tools }) => {
      await tools.act({ kind: 'click', target: { role: 'button', name: 'Apply' } });
      return { goal: { text: 'Application received' }, factPlan };
    },
  });
  const seed = await reflex.run({
    key: 'apply-trial',
    job: name + '-seed',
    inputs: { id: 'item-seed' },
  });
  assert.equal(seed.status, 'completed', seed.error);
  return { store, host: reflex.options.host };
}

test(
  '100 renamed buttons request one repair, reuse it immediately, then promote only after the final audit',
  { timeout: 25_000 },
  async () => {
    const page = await browser.newPage();
    try {
      const { store, host } = await seeded('hundred', page);
      app.state.renamed = true;
      let repairs = 0;
      const used: string[] = [];
      const reflex = new Reflex({
        host,
        store,
        repair: async ({ observation }) => {
          repairs++;
          return [
            {
              kind: 'click',
              target: { ref: observation.elements.find((e) => e.name === 'Join trial')!.ref },
            },
          ];
        },
      });
      const batch = await runMemoryBatch(reflex, {
        id: 'hundred',
        operation: 'apply-trial',
        items: items(100),
        policy: () => policy,
        onItem: (_row, result) => {
          if (result?.experience) used.push(result.experience);
        },
      });
      assert.equal(repairs, 1);
      assert.equal(new Set(used).size, 1);
      assert.ok(batch.rows.every((r) => r.status === 'attempted'));
      assert.equal((await store.provisional('hundred'))[0].status, 'provisional');
      assert.equal((await store.list()).length, 1);
      const settled = await settleMemoryBatch(
        store,
        'hundred',
        new Map(batch.rows.map((r) => [r.id, 'confirmed' as const])),
        'Independent fixture write list',
      );
      assert.equal(settled.candidates![0].status, 'promoted');
      assert.equal((await store.list()).length, 2);
      assert.equal(app.writes.filter((w) => /^item-\d/.test(w.id)).length, 100);
      const warm = await new Reflex({ host, store: new ExperienceStore(store.directory) }).run({
        key: 'apply-trial',
        job: 'later',
        inputs: { id: 'item-later' },
      });
      assert.equal(warm.status, 'completed', warm.error);
      assert.equal(warm.hostDelegations, 0);
    } finally {
      await page.close();
    }
  },
);

test('Current price and item identity override stale queue facts before dispatch', async () => {
  const page = await browser.newPage();
  try {
    const { store, host } = await seeded('facts', page);
    const before = app.writes.length;
    app.state.price = 49;
    const price = await runMemoryBatch(new Reflex({ host, store }), {
      id: 'price',
      operation: 'apply-trial',
      items: items(1),
      policy: () => policy,
    });
    assert.equal(price.rows[0].status, 'skipped');
    assert.match(price.rows[0].reason!, /Live facts/);
    assert.equal(app.writes.length, before);
    app.state.price = 0;
    app.state.wrongIdentity = true;
    await page.goto(app.origin + '/item/item-000');
    const identity = await runMemoryBatch(new Reflex({ host, store }), {
      id: 'identity',
      operation: 'apply-trial',
      items: items(1),
      policy: () => policy,
    });
    assert.equal(identity.rows[0].status, 'skipped');
    assert.match(identity.rows[0].reason!, /identity/);
    assert.equal(app.writes.length, before);
  } finally {
    await page.close();
  }
});

test('Verification levels have distinct costs and never equate a success toast with independent readback', async () => {
  for (const verification of ['attempt', 'batch', 'readback'] as Verification[]) {
    const page = await browser.newPage();
    try {
      const { store, host } = await seeded('level-' + verification, page);
      app.state.optimistic = true;
      const before = app.writes.length;
      let audits = 0,
        reads = 0;
      const batch = await runMemoryBatch(new Reflex({ host, store }), {
        id: verification,
        operation: 'apply-trial',
        items: items(3),
        policy: () => policy,
        verification,
        audit: async (ids) => {
          audits++;
          return new Map(ids.map((id) => [id, 'rejected' as const]));
        },
        readback: async (item) => {
          reads++;
          return {
            status: app.writes.slice(before).some((w) => w.id === item.id)
              ? 'confirmed'
              : 'rejected',
            source: 'Independent fixture write list',
          };
        },
      });
      assert.equal(audits, verification === 'batch' ? 1 : 0);
      assert.equal(reads, verification === 'readback' ? 3 : 0);
      assert.ok(
        batch.rows.every(
          (r) => r.status === (verification === 'attempt' ? 'attempted' : 'rejected'),
        ),
      );
    } finally {
      await page.close();
    }
  }
});

test('Repeated row targets follow stable item identity after reordering, without an ordinal', async () => {
  const page = await browser.newPage();
  try {
    app.state.wrongIdentity = false;
    app.state.optimistic = false;
    app.state.price = 0;
    app.state.reversed = false;
    const store = new ExperienceStore(join(directory, 'rows'));
    await page.goto(app.origin + '/list');
    const reflex = new Reflex({
      host: new BrowserHost(page),
      store,
      explore: async ({ tools }) => {
        const state = await tools.observe();
        const target = state.elements.find((e) => e.locator.within?.includes('item-b'))!;
        assert.equal(target.locator.index, undefined);
        await tools.act({ kind: 'click', target: { ref: target.ref } });
        return { goal: { text: 'Application received' } };
      },
    });
    assert.equal(
      (await reflex.run({ key: 'row-apply', job: 'row-first', inputs: {} })).status,
      'completed',
    );
    app.state.reversed = true;
    const result = await reflex.run({ key: 'row-apply', job: 'row-second', inputs: {} });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(app.writes.at(-1)!.id, 'item-b');
  } finally {
    await page.close();
  }
});

test('An unavailable independent readback stays unknown after a dispatched write', async () => {
  const page = await browser.newPage();
  try {
    const { store, host } = await seeded('readback-outage', page),
      before = app.writes.length;
    const result = await new Reflex({ host, store }).run({
      key: 'apply-trial',
      job: 'outage',
      inputs: { id: 'item-outage' },
      verification: 'readback',
      readback: async () => {
        throw new Error('Record store unavailable');
      },
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(app.writes.length, before + 1);
    const retry = await new Reflex({ host, store }).run({
      key: 'apply-trial',
      job: 'outage',
      inputs: { id: 'item-outage' },
      verification: 'readback',
      readback: async () => ({ status: 'confirmed', source: 'Independent fixture write list' }),
    });
    assert.equal(retry.status, 'uncertain');
    assert.equal(app.writes.length, before + 1);
  } finally {
    await page.close();
  }
});

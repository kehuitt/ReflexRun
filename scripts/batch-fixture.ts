import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { marketApp } from '../test/fixtures/market.js';
import { Reflex } from '../src/memory/session.js';
import { BrowserHost } from '../src/memory/browser.js';
import { ExperienceStore } from '../src/memory/store.js';
import { runMemoryBatch } from '../src/memory/batch.js';
import type { FactPlan, Verification } from '../src/memory/types.js';

/** Real UI fixture experiment. Both exploration and repair providers are explicitly scripted. */
export async function runBatchFixture(
  openPage: (url: string) => Promise<Page>,
  options: { verification: Verification; changedPrice?: boolean },
) {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-batch-fixture-')),
    app = await marketApp();
  try {
    const page = await openPage(app.origin + '/item/fixture-seed'),
      store = new ExperienceStore(directory);
    const plan: FactPlan = {
      identity: { pattern: 'Item ID: ([^\\n]+)', expected: { $input: 'id' } },
      fields: { price: { pattern: 'Price: (¥[0-9.]+)', parse: 'money' } },
    };
    let repairs = 0,
      audits = 0,
      readbacks = 0;
    const reflex = new Reflex({
      host: new BrowserHost(page),
      store,
      explore: async ({ tools }) => {
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Apply' } });
        return { goal: { text: 'Application received' }, factPlan: plan };
      },
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
    const seed = await reflex.run({
      key: 'fixture.trial.apply',
      job: 'seed',
      inputs: { id: 'fixture-seed' },
    });
    if (seed.status !== 'completed') throw new Error(seed.error ?? 'Fixture seed failed');
    app.state.renamed = true;
    const at = performance.now();
    const result = await runMemoryBatch(reflex, {
      id: 'fixture-batch',
      operation: 'fixture.trial.apply',
      verification: options.verification,
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `fixture-${String(i).padStart(3, '0')}`,
        label: 'Synthetic trial',
        facts: { price: 0 },
        inputs: { id: `fixture-${String(i).padStart(3, '0')}` },
      })),
      policy: () => ({ revision: 1, rules: [{ field: 'price', op: 'eq', value: 0 }] }),
      onItem: (row) => {
        if (options.changedPrice && row.id === 'fixture-049') app.state.price = 49;
        if (row.id === 'fixture-050') app.state.price = 0;
      },
      audit: async (ids) => {
        audits++;
        return new Map(
          ids
            .filter((id) => app.writes.some((w) => w.id === id))
            .map((id) => [id, 'confirmed' as const]),
        );
      },
      readback: async (item) => {
        readbacks++;
        return {
          status: app.writes.some((w) => w.id === item.id) ? 'confirmed' : 'rejected',
          source: 'Isolated trial fixture backend',
        };
      },
    });
    const writes = app.writes.filter((w) => w.id !== 'fixture-seed');
    return {
      verification: options.verification,
      elapsedMs: Math.round(performance.now() - at),
      items: result.rows.length,
      repairs,
      audits,
      readbacks,
      attempted: result.rows.filter((r) => r.status === 'attempted').length,
      confirmed: result.rows.filter((r) => r.status === 'confirmed').length,
      skipped: result.rows.filter((r) => r.status === 'skipped').length,
      unknown: result.rows.filter((r) => r.status === 'unknown').length,
      writes: writes.length,
      paidWrites: writes.filter((w) => w.price !== 0).length,
      duplicates: writes.length - new Set(writes.map((w) => w.id)).size,
      candidates: result.candidates,
      coverage: result.coverage,
      provider: 'Scripted fixture callbacks; no model/API calls',
      rows: result.rows,
    };
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

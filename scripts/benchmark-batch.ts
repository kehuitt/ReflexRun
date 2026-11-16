import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { runBatchFixture } from './batch-fixture.js';
import type { Verification } from '../src/memory/types.js';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const browser = await chromium.launch();
let page: Page | undefined;
try {
  const samples = [];
  for (const verification of ['attempt', 'batch', 'readback'] as Verification[]) {
    const result = await runBatchFixture(
      async (url) => {
        await page?.close();
        page = await browser.newPage();
        await page.goto(url);
        return page;
      },
      { verification },
    );
    assert.equal(result.items, 100);
    assert.equal(result.repairs, 1);
    assert.equal(result.writes, 100);
    assert.equal(result.duplicates, 0);
    assert.equal(result.paidWrites, 0);
    assert.equal(result.audits, verification === 'batch' ? 1 : 0);
    assert.equal(result.readbacks, verification === 'readback' ? 100 : 0);
    assert.equal(
      result.candidates![0].status,
      verification === 'attempt' ? 'provisional' : 'promoted',
    );
    samples.push(result);
    process.stderr.write(
      `${verification}: ${result.elapsedMs}ms, repair=${result.repairs}, audit=${result.audits}, readbacks=${result.readbacks}\n`,
    );
  }
  const changedPrice = await runBatchFixture(
    async (url) => {
      await page?.close();
      page = await browser.newPage();
      await page.goto(url);
      return page;
    },
    { verification: 'batch', changedPrice: true },
  );
  assert.equal(changedPrice.writes, 99);
  assert.equal(changedPrice.skipped, 1);
  assert.equal(changedPrice.paidWrites, 0);
  assert.equal(changedPrice.candidates![0].status, 'promoted');
  const output =
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        version: '0.3.0',
        browser: browser.version(),
        disclosure:
          'Actual browser actions and independent fixture state. Exploration/repair callbacks are scripted; no live LLM. No observer frames during measurement.',
        samples,
        changedPrice,
      },
      null,
      2,
    ) + '\n';
  if (values.out) await writeFile(values.out, output);
  else console.log(output);
} finally {
  await page?.close();
  await browser.close();
}

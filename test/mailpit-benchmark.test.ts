import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Experience, Json } from '../src/memory/types.js';
import {
  deriveFaultPlan,
  driftState,
  installDrift,
  phaseTiming,
  serialHandler,
  verifiedDriftWitness,
} from '../scripts/benchmark-mailpit.js';

const memory = (actions: Json[]): Experience => ({
  format: 2,
  id: 'actual-first-model-experience',
  key: 'mailpit.tag-message',
  scope: 'https://mailbox.example.test',
  surface: 'web',
  createdAt: '2026-11-10',
  requiredInputs: ['subject', 'tag'],
  parameters: {},
  steps: actions.map((action, sourceIndex) => ({ action, sourceIndex, effect: true })),
  goal: { text: 'Inbox' },
  episode: 'first',
  exploratoryActions: actions.length,
  eliminatedActions: 0,
  capabilities: ['tool'],
});
const typed = (input: string, target: Json): Json => ({
  kind: 'tool',
  tool: 'browser_type',
  args: { text: { $input: input }, target: null },
  bindings: { target },
  valuePaths: ['text'],
});

test('An unconfirmed phase has no negative or borrowed success time, but retains failure wall time', () => {
  const at = (monotonicMs: number) => ({ at: 'synthetic-clock', monotonicMs });
  const failed = phaseTiming(at(100), at(90), at(180));
  assert.equal(failed.businessReady, undefined);
  assert.equal(failed.businessReadyMs, undefined);
  assert.equal(failed.persistenceTailMs, undefined);
  assert.equal(failed.batchReadyMs, 80);
  const completed = phaseTiming(at(100), at(150), at(180));
  assert.equal(completed.businessReadyMs, 50);
  assert.equal(completed.persistenceTailMs, 30);
  assert.equal(phaseTiming(at(100), undefined, at(180)).businessReadyMs, undefined);
});

test('Drift comes from the first real input binding and prefers subject over tag', () => {
  const plan = deriveFaultPlan(
    memory([
      typed('tag', { role: 'textbox', name: 'Labels' }),
      typed('subject', { role: 'textbox', name: 'Search mailbox' }),
    ]),
  );
  assert.equal(plan.sourceExperience, 'actual-first-model-experience');
  assert.equal(plan.sourceStep, 1);
  assert.equal(plan.input, 'subject');
  assert.deepEqual(plan.target, { role: 'textbox', name: 'Search mailbox' });
  assert.equal(
    deriveFaultPlan(memory([typed('tag', { role: 'combobox', name: 'Tags' })])).input,
    'tag',
  );
});

test('Dynamic, ordinal and unobserved targets do not become an invented static fault plan', () => {
  const targets: Json[] = [
    { role: 'textbox', name: { $input: 'subject' } },
    { role: 'textbox', name: 'Search', index: 1 },
    { role: 'textbox', name: 'Search', within: { $input: 'subject' } },
    { role: 'textbox', name: 'Search', frames: ['frame-1'] },
    { role: 'button', name: 'Open email' },
    { role: 'textbox' },
  ];
  for (const target of targets)
    assert.throws(() => deriveFaultPlan(memory([typed('subject', target)])), /no unique static/);
  assert.throws(() => deriveFaultPlan(memory([])), /no unique static/);
});

test('A real static row scope is preserved as provenance, without inventing a row selector', () => {
  const original = { role: 'combobox', name: 'Type a value', within: 'snapshot:row:Tags' };
  const plan = deriveFaultPlan(memory([typed('tag', original)]));
  assert.deepEqual(plan.sourceTarget, original);
  assert.deepEqual(plan.target, { role: 'combobox', name: 'Type a value' });
});

test('Bulk input binding derives the corresponding field target rather than its neighbor', () => {
  const plan = deriveFaultPlan(
    memory([
      {
        kind: 'tool',
        tool: 'browser_fill_form',
        args: {
          fields: [
            { value: { $input: 'tag' } },
            { value: { $template: ['subject:', { $input: 'subject' }] } },
          ],
        },
        bindings: {
          'fields.0.target': { role: 'textbox', name: 'Tags' },
          'fields.1.target': { role: 'searchbox', name: 'Find' },
        },
      },
    ]),
  );
  assert.equal(plan.input, 'subject');
  assert.deepEqual(plan.target, { role: 'searchbox', name: 'Find' });
});

test('Both normal model callbacks serialize and retain ordering after a rejected call', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const handle = serialHandler(async (name) => {
    seen.push('start:' + name);
    if (name === 'one') await blocked;
    seen.push('end:' + name);
    if (name === 'two') throw new Error('expected tool rejection');
    return [{ type: 'inputText', text: name }];
  });
  const one = handle('one', {});
  const two = handle('two', {});
  const rejected = assert.rejects(two, /expected tool rejection/);
  const three = handle('three', {});
  await Promise.resolve();
  assert.deepEqual(seen, ['start:one']);
  release();
  await Promise.all([one, rejected, three]);
  assert.deepEqual(seen, [
    'start:one',
    'end:one',
    'start:two',
    'end:two',
    'start:three',
    'end:three',
  ]);
});

test('A renamed input may persist or remount during each item, but cannot vanish without a new witness', () => {
  const state = { replacementCount: 1, oldCount: 0, injection: { patches: 1, ambiguous: false } };
  assert.equal(verifiedDriftWitness(state, 1), true);
  assert.equal(verifiedDriftWitness({ ...state, replacementCount: 0 }, 0), true);
  assert.equal(verifiedDriftWitness({ ...state, replacementCount: 0 }, 1), false);
  assert.equal(verifiedDriftWitness({ ...state, oldCount: 1 }, 0), false);
  assert.equal(verifiedDriftWitness({ ...state, replacementCount: 2 }, 0), false);
  assert.equal(
    verifiedDriftWitness({ ...state, injection: { patches: 1, ambiguous: true } }, 0),
    false,
  );
});

test(
  'Real Chromium receives a self-contained drift observer and keeps relabeling remounted inputs',
  { timeout: 15000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.setContent('<main>No input is mounted yet</main>');
      const plan = deriveFaultPlan(
        memory([
          typed('tag', { role: 'combobox', name: 'Type a value', within: 'snapshot:row:Tags' }),
        ]),
      );
      assert.equal(await page.evaluate(() => '__name' in window), false);
      await installDrift(page, plan);
      for (let item = 0; item < 2; item++) {
        await page.evaluate(() => {
          document.body.innerHTML = '<input role="combobox" placeholder="Type a value">';
        });
        await page.getByRole('combobox', { name: plan.replacement, exact: true }).waitFor();
        const state = await driftState(page, plan);
        assert.equal(state.replacementCount, 1);
        assert.equal(state.oldCount, 0);
        assert.equal(state.injection.nodes, item + 1);
        assert.equal(state.injection.patches, item + 1);
        assert.equal(verifiedDriftWitness(state, item), true);
        await page.evaluate(() => {
          document.body.innerHTML = '<main>Input unmounted</main>';
        });
      }
      assert.equal(await page.evaluate(() => '__name' in window), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  'Chromium ignores hidden duplicates and waits through a genuine two-control transition',
  { timeout: 15000 },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.setContent(
        '<div aria-hidden="true"><input role="combobox" placeholder="Type a value"></div><div style="visibility:hidden"><input role="combobox" placeholder="Type a value"></div><div hidden><input role="combobox" placeholder="Type a value"></div><input role="combobox" placeholder="Type a value">',
      );
      const plan = deriveFaultPlan(
        memory([typed('tag', { role: 'combobox', name: 'Type a value' })]),
      );
      await installDrift(page, plan);
      await page.getByRole('combobox', { name: plan.replacement, exact: true }).waitFor();
      let state = await driftState(page, plan);
      assert.equal(state.injection.ambiguous, false);
      assert.equal(state.injection.patches, 1);
      assert.ok(
        state.injection.observations.some(
          (row: { matched: number; visibleMatches: number }) => row.matched > row.visibleMatches,
        ),
      );
      assert.equal(
        await page.locator('[placeholder="Type a value"]').count(),
        3,
        'Hidden copies remain untouched',
      );
      await page.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input role="combobox" placeholder="Type a value">',
        );
      });
      await page.waitForFunction(
        () => (window as any).__reflexrunEvaluationDrift.ambiguous === true,
      );
      state = await driftState(page, plan);
      assert.equal(state.oldCount, 1, 'A real second visible input was not relabeled');
      assert.equal(state.replacementCount, 1);
      assert.equal(state.injection.patches, 1);
      assert.equal(verifiedDriftWitness(state, 1), false);
      await page
        .getByRole('combobox', { name: plan.replacement, exact: true })
        .evaluate((node) => node.remove());
      await page.waitForFunction(
        () => (window as any).__reflexrunEvaluationDrift.ambiguous === false,
      );
      state = await driftState(page, plan);
      assert.equal(state.replacementCount, 1);
      assert.equal(state.oldCount, 0);
      assert.equal(state.injection.patches, 2);
      assert.ok(
        state.injection.ambiguousObservations > 0,
        'Transient ambiguity is retained as evidence',
      );
      assert.equal(verifiedDriftWitness(state, 1), true);
      await page.evaluate(() => {
        document.body.innerHTML = '<main>Unmounted</main>';
      });
      await page.evaluate(() => {
        document.body.innerHTML = '<input role="combobox" placeholder="Type a value">';
      });
      await page.getByRole('combobox', { name: plan.replacement, exact: true }).waitFor();
      state = await driftState(page, plan);
      assert.equal(state.injection.patches, 3);
      assert.equal(verifiedDriftWitness(state, 2), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

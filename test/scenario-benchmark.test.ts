import test from 'node:test';
import assert from 'node:assert/strict';
import type { NativeCall } from '../src/proxy/index.js';
import { targetOnlyNativePatch } from '../scripts/live-runtime.js';
import {
  exactNewDraft,
  exactMailMove,
  exactInvoiceDownload,
  writtenFields,
  scenarioInputs,
  type DraftRecord,
} from '../scripts/benchmark-scenarios.js';

const draft = (id: string, index = 0): DraftRecord => ({
  id,
  scenario: 'expense',
  fields: structuredClone(writtenFields('expense', scenarioInputs.expense[index])),
});

test('An input target repair can update its description without changing content or submission', () => {
  const original: NativeCall = {
    name: 'browser_type',
    arguments: { target: 'e1', element: 'Search', text: 'Receipt 42', submit: true },
  };
  const proposed: NativeCall = {
    name: 'browser_type',
    arguments: { ...original.arguments, target: 'e9', element: 'Find messages' },
  };
  assert.equal(targetOnlyNativePatch(original, proposed, ['target']), true);
  const { element: _description, ...withoutDescription } = original.arguments;
  assert.equal(
    targetOnlyNativePatch({ ...original, arguments: withoutDescription }, proposed, ['target']),
    true,
    'A descriptive field may be added when it was omitted from the original native call',
  );
  const changes: NativeCall['arguments'][] = [
    { text: 'Wrong receipt' },
    { submit: false },
    { slowly: true },
  ];
  for (const changed of changes)
    assert.equal(
      targetOnlyNativePatch(
        original,
        {
          ...proposed,
          arguments: { ...proposed.arguments, ...changed },
        },
        ['target'],
      ),
      false,
    );
});

test('Bounded repair allows a new click target description but preserves all behavior arguments', () => {
  const original = {
    name: 'browser_click',
    arguments: { target: 'e1', element: 'Save draft', button: 'left', modifiers: [] },
  };
  const candidate = {
    name: 'browser_click',
    arguments: { ...original.arguments, target: 'e8', element: 'Save expense' },
  };
  assert.equal(targetOnlyNativePatch(original, candidate, ['target']), true);
  assert.equal(
    targetOnlyNativePatch(original, { ...candidate, name: 'browser_type' }, ['target']),
    false,
  );
  const changes: NativeCall['arguments'][] = [
    { button: 'right' },
    { modifiers: ['Shift'] },
    { doubleClick: true },
  ];
  for (const changed of changes) {
    assert.equal(
      targetOnlyNativePatch(
        original,
        { ...candidate, arguments: { ...candidate.arguments, ...changed } },
        ['target'],
      ),
      false,
    );
  }
});

test('Independent business readback confirms all fields and one new identity', () => {
  const baseline = [draft('old')];
  const next = draft('new', 1);
  // Object insertion order is not business content.
  next.fields = Object.fromEntries(Object.entries(next.fields).reverse());
  assert.equal(
    exactNewDraft(
      baseline,
      [...baseline, next],
      'expense',
      writtenFields('expense', scenarioInputs.expense[1]),
    ).confirmed,
    true,
  );
  assert.equal(
    exactNewDraft(
      [],
      [draft('first')],
      'expense',
      writtenFields('expense', scenarioInputs.expense[0]),
    ).confirmed,
    true,
  );
});

test('Selection display aliases are task parameters, while readback compares only backend fields', () => {
  const expense = writtenFields('expense', scenarioInputs.expense[0]);
  assert.equal(expense.category, 'travel');
  assert.ok(!('categoryLabel' in expense));
  assert.deepEqual(
    writtenFields('invoice', { orderId: 'ORD-1', title: 'Identity title', amount: '12.50' }),
    { orderId: 'ORD-1', amount: '12.50' },
  );
  assert.deepEqual(
    writtenFields('mail', {
      mailId: 'MAIL-1',
      subject: 'Identity subject',
      sourceFolder: 'inbox',
      folder: 'receipts',
      folderLabel: 'Receipts',
    }),
    { mailId: 'MAIL-1', folder: 'receipts' },
  );
});

test('Display-name-only matches and missing writes cannot pass independent readback', () => {
  const wrongAmount = draft('new');
  wrongAmount.fields.amount = '99.99';
  const wrongCategory = draft('new');
  wrongCategory.fields.category = 'office';
  const missingField = draft('new');
  delete missingField.fields.note;
  const extraField = draft('new');
  extraField.fields.unrequested = 'unexpected';
  for (const row of [wrongAmount, wrongCategory, missingField, extraField]) {
    const check = exactNewDraft(
      [],
      [row],
      'expense',
      writtenFields('expense', scenarioInputs.expense[0]),
    );
    assert.equal(check.confirmed, false);
    assert.equal(check.terminal, true, 'A wrong actual write must stop automatic retries');
  }
  assert.deepEqual(
    exactNewDraft([], [], 'expense', writtenFields('expense', scenarioInputs.expense[0])),
    {
      confirmed: false,
      terminal: false,
      reason: 'Missing write',
    },
  );
});

test('Changed previous records, duplicate identities and extra writes are rejected', () => {
  const baseline = [draft('old')];
  const changed = draft('old');
  changed.fields.note = 'Overwrote an existing draft';
  const wrongScenario = { ...draft('new', 1), scenario: 'invoice' as const };
  for (const records of [
    [changed, draft('new', 1)],
    [draft('new', 1)],
    [...baseline, draft('old', 1)],
    [...baseline, draft('', 1)],
    [...baseline, wrongScenario],
    [...baseline, draft('new', 1), draft('extra', 2)],
  ]) {
    const check = exactNewDraft(
      baseline,
      records,
      'expense',
      writtenFields('expense', scenarioInputs.expense[1]),
    );
    assert.equal(check.confirmed, false);
    assert.equal(check.terminal, true);
  }
});

test('Mail readback requires the exact identity and preserves every other message field', () => {
  const baseline = [
    { id: 'm1', subject: 'Receipt', sender: 'demo@example.test', folder: 'inbox' },
    { id: 'm2', subject: 'Meeting', sender: 'other@example.test', folder: 'inbox' },
  ];
  const correct = baseline.map((row) => (row.id === 'm1' ? { ...row, folder: 'receipts' } : row));
  assert.equal(exactMailMove(baseline, correct, 'm1', 'receipts'), true);
  assert.equal(exactMailMove(baseline, correct, 'm2', 'receipts'), false);
  assert.equal(
    exactMailMove(
      baseline,
      correct.map((row) => ({ ...row, subject: 'Changed' })),
      'm1',
      'receipts',
    ),
    false,
  );
  assert.equal(
    exactMailMove(correct, correct, 'm1', 'receipts'),
    false,
    'Repeated confirmation cannot stand in for a new move',
  );
});

test('Invoice readback rejects name-only downloads, wrong amounts and modified prior bytes', () => {
  const body =
    '%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\nstream\n(Order: ORD-1)\n(Amount: CNY 12.50)\nendstream\nendobj\n';
  const content = body + `xref\n0 3\ntrailer\n<< /Size 3 >>\nstartxref\n${body.length}\n%%EOF\n`;
  const file = { id: '1', filename: 'invoice-ORD-1.pdf', sha256: 'fixture-digest', content };
  assert.equal(exactInvoiceDownload([], [file], 'ORD-1', '12.50'), true);
  assert.equal(
    exactInvoiceDownload([], [{ ...file, content: 'fake invoice' }], 'ORD-1', '12.50'),
    false,
  );
  assert.equal(exactInvoiceDownload([], [file], 'ORD-1', '99.99'), false);
  assert.equal(
    exactInvoiceDownload(
      [file],
      [
        { ...file, sha256: 'changed' },
        { ...file, id: '2' },
      ],
      'ORD-1',
      '12.50',
    ),
    false,
  );
  assert.equal(exactInvoiceDownload([], [file, { ...file, id: '2' }], 'ORD-1', '12.50'), false);
});

test('Form benchmark inputs are synthetic and contain five distinct tasks per scenario', () => {
  for (const [scenario, items] of Object.entries(scenarioInputs)) {
    assert.equal(items.length, 5, scenario);
    assert.equal(new Set(items.map((fields) => JSON.stringify(fields))).size, 5);
    for (const fields of items) {
      assert.ok(!('phone' in fields));
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { compileExperience, decode, elementFor, observation } from '../src/memory/compiler.js';
import { browserLocator } from '../src/memory/browser.js';
import { CuaBrowserHost, type CuaBrowserPort } from '../src/memory/cua-browser.js';
import { locator } from '../src/memory/action-schema.js';
import { fromPlaywrightSnapshot } from '../src/proxy/playwright.js';
import type { Action, Element, Inputs, Locator, Observation } from '../src/memory/types.js';

const subject = 'Receipt Cedar workshop';
const nextSubject = 'Invoice Harbor hosting';

test('Repeated first-cell labels use the unique observed selection identity across reordered rows', () => {
  const fileRow = (name: string, ref: string) =>
    `  - row [ref=${ref}-row]:\n    - cell:\n      - checkbox ${JSON.stringify('Select file ' + name)} [ref=${ref}-select]\n    - cell "View":\n      - button "View" [ref=${ref}-view]\n    - cell:\n      - button "Actions" [ref=${ref}]`;
  const first = fromPlaywrightSnapshot(
    '### Snapshot\n' + fileRow('Alpha.txt', 'a') + '\n' + fileRow('Beta.txt', 'b'),
  );
  const target = first.elements.find((element) => element.ref === 'b')!.locator;
  assert.deepEqual(target, {
    role: 'button',
    name: 'Actions',
    within: 'snapshot:identity:row:Select file Beta.txt',
  });
  const reordered = fromPlaywrightSnapshot(
    '### Snapshot\n' + fileRow('Beta.txt', 'new-b') + '\n' + fileRow('Alpha.txt', 'new-a'),
  );
  assert.equal(elementFor(target, reordered)?.ref, 'new-b');
});

test('An inferred row identity cannot resolve to an unrelated row with the same first cell', () => {
  const rowWithControl = (ref: string, cell: string, selection = '') =>
    `- row:\n  - cell ${JSON.stringify(cell)}\n${selection}  - button "Actions" [ref=${ref}]`;
  const alpha = rowWithControl('a', 'View', '  - checkbox "Alpha" [ref=check-a]\n');
  const beta = rowWithControl('b', 'View', '  - checkbox "Beta" [ref=check-b]\n');
  const unrelated = rowWithControl('other', 'Alpha');
  const original = fromPlaywrightSnapshot([alpha, beta, unrelated].join('\n'));
  const target = original.elements.find((element) => element.ref === 'a')!.locator;
  const reordered = fromPlaywrightSnapshot([unrelated, beta, alpha].join('\n'));
  assert.equal(elementFor(target, reordered)?.ref, 'a');
  assert.equal(elementFor(target, fromPlaywrightSnapshot(unrelated)), undefined);
});

test('A listbox option is scoped by its observed filter label rather than historical links', () => {
  const state = fromPlaywrightSnapshot(`### Snapshot
- link "review" [ref=history]
- combobox [ref=labels]:
  - listbox [ref=choices]:
    - textbox "Filter labels" [ref=filter]
    - link "review" [ref=option]
`);
  const target = state.elements.find((element) => element.ref === 'option')!.locator;
  assert.deepEqual(target, {
    role: 'link',
    name: 'review',
    within: 'snapshot:listbox:Filter labels',
  });
  assert.equal(elementFor(target, state)?.ref, 'option');
});
const row = (ref: string, identity: string, metadata: string, extra: Locator = {}): Element => {
  const name = `Example Sender To: recipient@example.test ${identity} ${metadata}`;
  return { ref, role: 'link', name, locator: { role: 'link', name, ...extra } };
};
const view = (elements: Element[]) =>
  observation({
    surface: 'web',
    scope: 'https://mail.example.test',
    title: 'Mailbox',
    text: '',
    elements,
  });
function learn(
  before: Observation,
  target: Locator,
  inputs: Inputs = { subject, tag: 'Expenses' },
) {
  return compileExperience({
    key: 'message.tag',
    scope: before.scope,
    episode: 'observed-success',
    inputs,
    goal: { text: 'Tagged' },
    trace: [
      {
        before,
        dispatched: true,
        durationMs: 1,
        action: {
          kind: 'tool',
          tool: 'browser_click',
          args: { target: 'e1', button: 'left' },
          bindings: { target },
          target,
          valuePaths: [],
          effect: true,
        },
      },
    ],
  });
}

test('Learned message identity survives changed snippets, sizes and relative time without changing the native call', () => {
  const first = row('e1', subject, 'Synthetic local evaluation message 1. 594 B a day ago');
  const memory = learn(view([first]), first.locator);
  const action = decode(memory.steps[0].action, { subject: nextSubject, tag: 'Bills' }) as Action;
  assert.deepEqual(action.target, { role: 'link', nameIncludes: nextSubject });
  assert.deepEqual(action.bindings?.target, action.target);
  assert.deepEqual(action.args, { target: null, button: 'left' });
  assert.equal(action.effect, true);
  assert.equal(
    memory.steps[0].intent,
    undefined,
    'Partial identity is not an exact portable intent',
  );
  const next = row('e55', nextSubject, 'Synthetic local evaluation message 2. 621 B two days ago');
  assert.equal(elementFor(action.target, view([next]))?.ref, 'e55');
});

test('A unique record heading binds the task title while an issue number changes', () => {
  const heading: Element = {
    ref: 'e1',
    role: 'heading',
    name: subject + ' #1',
    locator: { role: 'heading', name: subject + ' #1' },
  };
  const memory = learn(view([heading]), heading.locator);
  const action = decode(memory.steps[0].action, { subject: nextSubject }) as Action;
  const next = {
    ...heading,
    ref: 'e2',
    name: nextSubject + ' #42',
    locator: { role: 'heading', name: nextSubject + ' #42' },
  };
  assert.deepEqual(action.target, { role: 'heading', nameIncludes: nextSubject });
  assert.equal(elementFor(action.target, view([next]))?.ref, 'e2');
  assert.equal(elementFor(action.target, view([next, { ...next, ref: 'e3' }])), undefined);
});

test('Identity matching retains frame and container context and refuses an ordinal escape from ambiguity', () => {
  const context = { frames: ['iframe.mail'], within: 'snapshot:row:mail' };
  const first = row('e1', subject, '594 B', context);
  const action = decode(learn(view([first]), first.locator).steps[0].action, {
    subject: nextSubject,
  }) as Action;
  const next = row('e2', nextSubject, '610 B', context);
  const otherFrame = row('e3', nextSubject, '610 B', { ...context, frames: ['iframe.other'] });
  const otherContainer = row('e4', nextSubject, '610 B', {
    ...context,
    within: 'snapshot:row:other',
  });
  assert.equal(elementFor(action.target, view([next, otherFrame, otherContainer]))?.ref, 'e2');
  const duplicate = row('e5', nextSubject, 'Other content', context);
  assert.equal(elementFor(action.target, view([next, duplicate])), undefined);
  assert.equal(elementFor({ ...action.target, index: 0 }, view([next, duplicate])), undefined);
});

test('Only unique partial task identities on collection entries are inferred', () => {
  const first = row('e1', subject, 'Expenses 594 B');
  const memory = learn(view([first]), first.locator, { subject, short: 'Cedar', tag: 'Expenses' });
  assert.deepEqual((decode(memory.steps[0].action, { subject: nextSubject }) as Action).target, {
    role: 'link',
    nameIncludes: nextSubject,
  });
  for (const [elements, inputs] of [
    [[first, row('e2', subject, 'Other copy')], { subject }],
    [[first], { subject, alias: subject }],
    [[first], { short: 'Ce' }],
  ] as [Element[], Inputs][]) {
    const action = decode(
      learn(view(elements), first.locator, inputs).steps[0].action,
      inputs,
    ) as Action;
    assert.equal(action.target?.nameIncludes, undefined);
  }
  const toolbar: Element = {
    ...first,
    role: 'button',
    locator: { role: 'button', name: first.name },
  };
  const action = decode(learn(view([toolbar]), toolbar.locator).steps[0].action, {
    subject: nextSubject,
    tag: 'Bills',
  }) as Action;
  assert.equal(action.target?.nameIncludes, undefined, 'Toolbar action wording must stay intact');
});

test('Partial identity locators require a role and cannot mix exact, CSS, ref or ordinal targets', () => {
  assert.equal(locator.safeParse({ role: 'link', nameIncludes: subject }).success, true);
  for (const extra of [
    { role: undefined },
    { index: 0 },
    { name: subject },
    { css: 'a' },
    { ref: 'e1' },
  ])
    assert.equal(
      locator.safeParse({ role: 'link', nameIncludes: subject, ...extra }).success,
      false,
    );
});

test('Browser partial matching escapes regular-expression syntax and never clicks an ambiguous row', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<a href="#one">Sender Receipt [A]+ fresh metadata</a><a href="#two">Sender Receipt AAA fresh metadata</a>',
    );
    const target = browserLocator(page, { role: 'link', nameIncludes: 'Receipt [A]+' });
    assert.equal(await target.count(), 1);
    await target.click();
    assert.equal(new URL(page.url()).hash, '#one');
    await page.setContent('<a href="#one">Receipt [A]+ one</a><a href="#two">Receipt [A]+ two</a>');
    await assert.rejects(
      browserLocator(page, { role: 'link', nameIncludes: 'Receipt [A]+' }).click({ timeout: 100 }),
      /strict mode violation/,
    );
  } finally {
    await browser.close();
  }
});

test('A CUA browser port without partial-name support fails closed', async () => {
  const host = new CuaBrowserHost({ playwright: {} } as CuaBrowserPort);
  await assert.rejects(
    host.act({ kind: 'click', target: { role: 'link', nameIncludes: subject } }),
    /partial.*name|name.*partial/i,
  );
});

const countedButton = (count: number, label = 'Unread messages', action = ' Return to inbox') =>
  fromPlaywrightSnapshot(`- Page URL: https://mail.example.test/
### Snapshot
\`\`\`yaml
- button "${action} ${count}" [ref=e161]:
  - generic [ref=e162]: 
  - generic [ref=e163]: ${action}
  - generic "${label}" [ref=e164]: "${count}"
\`\`\``);

test('An explicitly labelled counter can change while the complete navigation action stays fixed', () => {
  const before = countedButton(8);
  const button = before.elements.find((element) => element.role === 'button')!;
  assert.equal(button.alternatives?.[0]?.nameIncludes, ' Return to inbox');
  const memory = learn(before, button.locator, {});
  const action = decode(memory.steps[0].action, {}) as Action;
  assert.deepEqual(action.target, { role: 'button', nameIncludes: ' Return to inbox' });
  assert.equal(memory.steps[0].intent, undefined);
  assert.equal(elementFor(action.target, countedButton(7))?.ref, 'e161');
});

test('Amounts and numbers inside action wording are never erased as counters', () => {
  const before = countedButton(100, 'Amount', 'Pay');
  const button = before.elements.find((element) => element.role === 'button')!;
  assert.equal(button.alternatives, undefined);
  const action = decode(learn(before, button.locator, {}).steps[0].action, {}) as Action;
  assert.equal(action.target?.name, 'Pay 100');
  assert.equal(elementFor(action.target, countedButton(200, 'Amount', 'Pay')), undefined);
  const counted = countedButton(8, 'Unread messages', 'Return to queue 100');
  const target = counted.elements.find((element) => element.role === 'button')!;
  const numbered = decode(learn(counted, target.locator, {}).steps[0].action, {}) as Action;
  assert.equal(numbered.target?.nameIncludes, 'Return to queue 100');
  assert.equal(
    elementFor(numbered.target, countedButton(7, 'Unread messages', 'Return to queue 200')),
    undefined,
  );
});

test('A named counter never removes a quantity from a business action', () => {
  for (const [action, label] of [
    ['Delete', 'Items'],
    ['Approve', 'Unread messages'],
    ['Pay', 'Unread messages'],
  ]) {
    const before = countedButton(3, label, action);
    const button = before.elements.find((element) => element.role === 'button')!;
    assert.equal(button.alternatives, undefined);
    const learned = decode(learn(before, button.locator, {}).steps[0].action, {}) as Action;
    assert.equal(learned.target?.name, `${action} 3`);
    assert.equal(elementFor(learned.target, countedButton(9, label, action)), undefined);
  }
});

test('Counter alternatives do not admit two controls with the same action prefix', () => {
  const before = countedButton(8);
  const first = before.elements.find((element) => element.role === 'button')!;
  const second = {
    ...first,
    ref: 'e2',
    name: ' Return to inbox 3',
    locator: { role: 'button', name: ' Return to inbox 3' },
  };
  const ambiguous = view([...before.elements, second]);
  const action = decode(learn(ambiguous, first.locator, {}).steps[0].action, {}) as Action;
  assert.equal(action.target?.nameIncludes, undefined);
  const learned = decode(learn(before, first.locator, {}).steps[0].action, {}) as Action;
  assert.equal(elementFor(learned.target, ambiguous), undefined);
});

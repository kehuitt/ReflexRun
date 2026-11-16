import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMailpitChange, type MailpitSnapshot } from '../scripts/mailpit-evaluation.js';

const input = { subject: 'Receipt Cedar workshop', tag: 'Expenses' };
const initial = (): MailpitSnapshot => ({
  total: 2,
  messages: [
    {
      ID: 'target',
      Subject: input.subject,
      Read: false,
      Tags: ['Existing'],
      rawSha256: 'original-target',
      From: { Address: 'sender@example.test' },
    },
    {
      ID: 'other',
      Subject: 'Unrelated newsletter',
      Read: false,
      Tags: ['Keep'],
      rawSha256: 'original-other',
    },
  ],
});
const correct = () => {
  const state = initial();
  state.messages[0].Read = true;
  state.messages[0].Tags.push(input.tag);
  return state;
};

test('Mailpit audit binds stable message identity and permits only the requested tag and read change', () => {
  const state = correct();
  state.messages.reverse();
  assert.equal(checkMailpitChange(initial(), state, input).confirmed, true);
});

test('Missing and partly completed updates do not count as a tagged, read message', () => {
  for (const state of [initial(), correct()]) {
    if (state.messages[0].Tags.includes(input.tag)) state.messages[0].Read = false;
    const check = checkMailpitChange(initial(), state, input);
    assert.equal(check.confirmed, false);
    assert.equal(check.terminal, false);
  }
  const state = correct();
  assert.equal(checkMailpitChange(state, state, input).confirmed, false);
});

test('Wrong identities, additional writes, lost old tags and changed bodies are terminal failures', () => {
  const wrongId = correct();
  wrongId.messages[0].ID = 'different-id';
  const wrongTag = correct();
  wrongTag.messages[0].Tags.push('Unrequested');
  const lostTag = correct();
  lostTag.messages[0].Tags = [input.tag];
  const changedBody = correct();
  changedBody.messages[0].rawSha256 = 'rewritten';
  const changedOther = correct();
  changedOther.messages[1].Read = true;
  const deletedOther = correct();
  deletedOther.messages.pop();
  deletedOther.total--;
  const extra = correct();
  extra.messages.push({ ...extra.messages[1], ID: 'extra' });
  extra.total++;
  const duplicate = correct();
  duplicate.messages[1].ID = 'target';
  for (const state of [
    wrongId,
    wrongTag,
    lostTag,
    changedBody,
    changedOther,
    deletedOther,
    extra,
    duplicate,
  ]) {
    const check = checkMailpitChange(initial(), state, input);
    assert.equal(check.confirmed, false);
    assert.equal(check.terminal, true, check.reason);
  }
});

test('An audit that marked another message read would be rejected as a reader side effect', () => {
  const state = correct();
  state.messages.forEach((message) => {
    message.Read = true;
  });
  assert.deepEqual(checkMailpitChange(initial(), state, input), {
    confirmed: false,
    terminal: true,
    reason: 'Another message changed',
  });
});

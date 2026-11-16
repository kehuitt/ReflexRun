import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Inputs, Readback } from '../src/memory/types.js';

export type MailpitInput = { subject: string; tag: string };
type MailpitSummary = {
  ID: string;
  Subject: string;
  Read: boolean;
  Tags: string[];
  [key: string]: unknown;
};
export type MailpitMessage = MailpitSummary & { rawSha256: string };
export type MailpitSnapshot = { total: number; messages: MailpitMessage[] };
export type MailpitReadback = Readback & { reason: string };

export const mailpitInputs: MailpitInput[] = [
  { subject: 'Receipt Cedar workshop', tag: 'Expenses' },
  { subject: 'Invoice Harbor hosting', tag: 'Bills' },
  { subject: 'Travel Juniper rail', tag: 'Expenses' },
  { subject: 'Receipt Maple lunch', tag: 'Review' },
  { subject: 'Invoice Orbit design', tag: 'Bills' },
  { subject: 'Travel Northstar taxi', tag: 'Review' },
  { subject: 'Receipt Pine stationery', tag: 'Expenses' },
];
const source = 'Official Mailpit GET message summaries and immutable raw-message SHA256';
const stamp = () => ({ at: new Date().toISOString(), monotonicMs: performance.now() });

/** Business-state checks only: this reader never marks a message read or edits a tag. */
export function checkMailpitChange(
  previous: MailpitSnapshot,
  current: MailpitSnapshot,
  input: MailpitInput,
) {
  const reject = (reason: string) => ({ confirmed: false, terminal: true, reason });
  const target = previous.messages.filter((message) => message.Subject === input.subject);
  if (target.length !== 1) return reject('Task subject has no unique original identity');
  const before = target[0];
  if (before.Tags.includes(input.tag))
    return reject('Requested tag was already present before this item');
  const ids = new Set(previous.messages.map((message) => message.ID));
  if (
    ids.size !== previous.messages.length ||
    previous.total !== previous.messages.length ||
    current.total !== previous.total ||
    current.messages.length !== previous.messages.length ||
    new Set(current.messages.map((message) => message.ID)).size !== ids.size ||
    current.messages.some((message) => !ids.has(message.ID))
  )
    return reject('Mailbox identities, message count or uniqueness changed');
  const next = current.messages.find((message) => message.ID === before.ID)!;
  for (const old of previous.messages) {
    const now = current.messages.find((message) => message.ID === old.ID);
    if (old.ID !== before.ID && !isDeepStrictEqual(now, old))
      return reject('Another message changed');
  }
  const stable = (message: MailpitMessage) => {
    const { Read: _read, Tags: _tags, ...rest } = message;
    return rest;
  };
  if (!isDeepStrictEqual(stable(before), stable(next)))
    return reject('Target identity, content or immutable metadata changed');
  const expectedTags = [...new Set([...before.Tags, input.tag])].sort();
  if (
    typeof next.Read !== 'boolean' ||
    !Array.isArray(next.Tags) ||
    new Set(next.Tags).size !== next.Tags.length ||
    before.Tags.some((tag) => !next.Tags.includes(tag)) ||
    next.Tags.some((tag) => !expectedTags.includes(tag))
  )
    return reject('Target has an incorrect tag or read state');
  const confirmed = next.Read && isDeepStrictEqual([...next.Tags].sort(), expectedTags);
  return {
    confirmed,
    terminal: false,
    reason: confirmed ? '' : 'Requested tag or read state is not yet stored',
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

export class MailpitEvaluation {
  readonly inputs = mailpitInputs.map((input) => ({ ...input }));
  readonly readbacks: {
    input: MailpitInput;
    started: ReturnType<typeof stamp>;
    observed: ReturnType<typeof stamp>;
    outcome: MailpitReadback;
    before: MailpitSnapshot;
    after?: MailpitSnapshot;
  }[] = [];
  private previous!: MailpitSnapshot;
  private constructor(
    readonly origin: string,
    readonly metadata: {
      application: string;
      version: string;
      binarySha256: string;
      smtpPort: number;
      seed: string;
      readback: string;
      startingMessages: number;
    },
    private readonly child: ChildProcess,
  ) {}

  static async start(binary: string, directory: string) {
    binary = resolve(binary);
    await mkdir(directory, { recursive: true });
    const http = await freePort();
    let smtp = await freePort();
    while (smtp === http) smtp = await freePort();
    const version = execFileSync(binary, ['version', '--no-release-check'], { encoding: 'utf8' })
      .trim()
      .replace(binary + ' ', '');
    const binarySha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    const args = [
      '--listen',
      '127.0.0.1:' + http,
      '--smtp',
      '127.0.0.1:' + smtp,
      '--database',
      join(resolve(directory), 'mailpit.sqlite'),
      '--disable-version-check',
      '--smtp-disable-rdns',
      '--block-remote-css-and-fonts',
      '--use-message-dates',
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MP_')),
    );
    const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let failure: Error | undefined,
      log = '';
    child.once('error', (error) => {
      failure = error;
    });
    child.stderr?.on('data', (chunk) => {
      log += chunk.toString();
    });
    const fixture = new MailpitEvaluation(
      'http://127.0.0.1:' + http,
      {
        application: 'Mailpit',
        version,
        binarySha256,
        smtpPort: smtp,
        seed: 'Nine synthetic RFC822 messages received by the official SMTP server via sendmail',
        readback: source,
        startingMessages: 9,
      },
      child,
    );
    try {
      const deadline = performance.now() + 10_000;
      while (true) {
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error('Mailpit exited before readiness: ' + log);
        try {
          if ((await fetch(fixture.origin + '/livez')).ok) break;
        } catch {}
        if (performance.now() >= deadline) throw new Error('Mailpit readiness timed out: ' + log);
        await new Promise((done) => setTimeout(done, 25));
      }
      const initial = await fixture.snapshot();
      assert.equal(initial.total, 0, 'Each actor needs a new empty Mailpit database');
      const subjects = [
        ...mailpitInputs.map((input) => input.subject),
        'Newsletter Community update',
        'Account Example notification',
      ];
      for (const [index, subject] of subjects.entries()) {
        const message = [
          'From: Example Sender <sender@example.test>',
          'To: Example Recipient <recipient@example.test>',
          'Date: Mon, 09 Nov 2026 10:' + String(index).padStart(2, '0') + ':00 +0000',
          'Message-ID: <reflexrun-mail-' + index + '@example.test>',
          'Subject: ' + subject,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          ...(index === subjects.length - 1 ? ['X-Tags: Keep'] : []),
          '',
          'Synthetic local evaluation message ' + String(index + 1) + '.',
          'Preserve this message body and every unrelated email.',
          '',
        ].join('\r\n');
        execFileSync(
          binary,
          [
            'sendmail',
            '-S',
            '127.0.0.1:' + smtp,
            '-f',
            'sender@example.test',
            'recipient@example.test',
          ],
          { env, input: message },
        );
      }
      fixture.previous = await fixture.snapshot();
      assert.equal(fixture.previous.total, subjects.length);
      assert.ok(fixture.previous.messages.every((message) => !message.Read));
      assert.deepEqual(
        new Set(fixture.previous.messages.map((message) => message.Subject)),
        new Set(subjects),
      );
      await writeFile(join(directory, 'mailpit.log'), log);
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  async snapshot(): Promise<MailpitSnapshot> {
    const response = await fetch(this.origin + '/api/v1/messages?limit=1000');
    if (!response.ok) throw new Error('Mailpit list reader returned ' + response.status);
    const data = (await response.json()) as {
      total: number;
      messages: MailpitSummary[];
    };
    const messages = await Promise.all(
      data.messages.map(async (message) => {
        const raw = await fetch(
          this.origin + '/api/v1/message/' + encodeURIComponent(String(message.ID)) + '/raw',
        );
        if (!raw.ok) throw new Error('Mailpit raw reader returned ' + raw.status);
        return {
          ...message,
          Tags: [...message.Tags].sort(),
          rawSha256: createHash('sha256')
            .update(Buffer.from(await raw.arrayBuffer()))
            .digest('hex'),
        } as MailpitMessage;
      }),
    );
    return { total: data.total, messages: messages.sort((a, b) => a.ID.localeCompare(b.ID)) };
  }

  async verify(input: Inputs): Promise<MailpitReadback> {
    assert.equal(typeof input.subject, 'string');
    assert.equal(typeof input.tag, 'string');
    const task = { subject: input.subject as string, tag: input.tag as string };
    const before = structuredClone(this.previous),
      started = stamp();
    let after: MailpitSnapshot | undefined;
    let outcome: MailpitReadback = { status: 'rejected', source, reason: 'No update observed' };
    try {
      while (true) {
        after = await this.snapshot();
        const check = checkMailpitChange(before, after, task);
        outcome = {
          status: check.confirmed ? 'confirmed' : 'rejected',
          source,
          reason: check.reason,
        };
        if (check.confirmed) {
          this.previous = after;
          break;
        }
        if (check.terminal || performance.now() - started.monotonicMs >= 2000) break;
        await new Promise((done) => setTimeout(done, 50));
      }
    } catch (error) {
      outcome = {
        status: 'unknown',
        source,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    this.readbacks.push({ input: task, started, observed: stamp(), outcome, before, after });
    return outcome;
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    const done = new Promise<void>((resolveClose) => this.child.once('exit', () => resolveClose()));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  }
}

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { inspectDesktopSkill } from '../dist/src/setup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'reflex-distribution-'));
const npm = process.env.npm_execpath;
const npmCommand = npm ? process.execPath : 'npm';
const npmPrefix = npm ? [npm] : [];
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1_000_000,
    windowsHide: true,
  });

function checkPublicFile(name, data) {
  if (
    /(?:^|\/)(?:\.git|\.reflexrun|\.codex|\.openai|node_modules)(?:\/|$)|(?:^|\/)(?:auth\.json|\.npmrc|\.netrc|\.env(?:\..*)?)$|\.(?:key|pem|p12|pfx)$/.test(
      name,
    ) &&
    !/(?:^|\/)\.env\.example$/.test(name)
  )
    throw new Error(`Private local file included in distribution: ${name}`);
  if (/\.(?:png|jpg|jpeg|gif|webp|woff2?)$/i.test(name)) return;
  const bytes = Buffer.from(data);
  let text;
  if (name.endsWith('.mp4')) {
    // Audit container metadata; compressed video bytes are not text. Review frames separately.
    const metadata = [];
    for (let offset = 0; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new Error(`Truncated MP4 box: ${name}`);
      const length = bytes.readUInt32BE(offset) || bytes.length - offset;
      if (length < 8 || offset + length > bytes.length) throw new Error(`Invalid MP4 box: ${name}`);
      if (bytes.toString('ascii', offset + 4, offset + 8) !== 'mdat')
        metadata.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    text = Buffer.concat(metadata).toString('utf8');
  } else text = bytes.toString('utf8');
  const findings = [];
  if (/(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)[^\s\\/'"<>]+/i.test(text))
    findings.push('personal-home-path');
  if (
    /(?<![\w-])(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|https?:\/\/[^\s/]+:[^\s/]+@/.test(
      text,
    )
  )
    findings.push('credential');
  const emails = [...text.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)];
  if (emails.some((match) => !/(?:^|\.)example\.(?:test|com|org|net)$|\.test$/.test(match[1])))
    findings.push('contact-email');
  // Fractional timing samples can contain phone-shaped digit sequences.
  const phoneText = name.endsWith('.json')
    ? JSON.stringify(JSON.parse(text), (_key, value) =>
        typeof value === 'number' && !Number.isInteger(value) ? null : value,
      )
    : text;
  if (/(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/.test(phoneText)) findings.push('phone-number');
  const addresses = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((match) => match[0]);
  if (
    addresses.some(
      (address) =>
        address.split('.').every((part) => Number(part) <= 255) &&
        !/^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(address),
    )
  )
    findings.push('network-address');
  if (/https?:\/\/[^\s/"']+\.(?:local|internal|lan)(?:[/:"'\s]|$)/i.test(text))
    findings.push('private-hostname');
  if (name.startsWith('benchmarks/') && name.endsWith('.json')) {
    const visit = (value, parent = '') => {
      if (!value || typeof value !== 'object') return;
      if (parent === 'turn' && Array.isArray(value.items)) {
        for (const item of value.items)
          if (typeof item?.id === 'string' && !/^<model-item-\d+>$/.test(item.id))
            findings.push('model-run-identifier');
      }
      for (const [key, child] of Object.entries(value)) {
        const identity =
          /^(?:thread|threadId|rootTurnId|turnId)$/.test(key) ||
          (parent === 'turn' && key === 'id');
        if (identity && typeof child === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(child))
          findings.push('model-run-identifier');
        visit(child, key);
      }
    };
    visit(JSON.parse(text));
  }
  if (findings.length)
    throw new Error(
      `Public-file privacy check failed for ${name}: ${[...new Set(findings)].join(', ')}`,
    );
}

assert.throws(
  () => checkPublicFile('probe.txt', Buffer.from('sk-' + 'x'.repeat(24))),
  /credential/,
);
assert.throws(
  () => checkPublicFile('probe.txt', new Uint8Array(Buffer.from('sk-' + 'x'.repeat(24)))),
  /credential/,
);
checkPublicFile('probe.json', new Uint8Array(Buffer.from('{"format":2}')));
assert.throws(
  () =>
    checkPublicFile(
      'probe.json',
      Buffer.from(JSON.stringify({ path: ['C:', 'Users', 'fixture'].join('\\') })),
    ),
  /personal-home-path/,
);
const testBox = (type, content) => {
  const box = Buffer.alloc(8 + Buffer.byteLength(content));
  box.writeUInt32BE(box.length);
  box.write(type, 4);
  box.write(content, 8);
  return box;
};
checkPublicFile('probe.mp4', testBox('mdat', 'mail' + '@' + 'private.invalid'));
assert.throws(
  () => checkPublicFile('probe.mp4', testBox('udta', 'mail' + '@' + 'private.invalid')),
  /contact-email/,
);
checkPublicFile(
  'synthetic.json',
  Buffer.from(JSON.stringify({ title: 'task-' + 'x'.repeat(30), email: 'fixture@example.test' })),
);
checkPublicFile('timing.json', Buffer.from('{"elapsedMs":0.' + '13800138' + '000}'));
for (const phone of ['138' + '0'.repeat(8), Number('138' + '0'.repeat(8))])
  assert.throws(
    () => checkPublicFile('probe.json', Buffer.from(JSON.stringify({ phone }))),
    /phone-number/,
  );
assert.throws(
  () =>
    checkPublicFile(
      'benchmarks/probe.json',
      Buffer.from(JSON.stringify({ turn: { items: [{ id: 'msg_' + 'x'.repeat(50) }] } })),
    ),
  /model-run-identifier/,
);
checkPublicFile(
  'benchmarks/probe.json',
  Buffer.from(JSON.stringify({ turn: { items: [{ id: '<model-item-01>' }] } })),
);

try {
  const sourceZip = process.argv[2];
  if (sourceZip) {
    const files = unzipSync(await readFile(sourceZip));
    for (const [name, data] of Object.entries(files)) {
      assert.match(name, /^reflexrun\/(?:[^/]+\/)*[^/]+$/);
      const parts = name.split('/');
      assert.ok(!parts.some((part) => part === '..' || part === '.' || part.includes('\\')));
      assert.ok(
        !parts.some((part) => ['AGENTS.md', 'dist', 'work', 'test-results'].includes(part)),
      );
      checkPublicFile(parts.slice(1).join('/'), data);
      assert.deepEqual(Buffer.from(data), await readFile(join(root, ...parts.slice(1))), name);
    }
    console.log('Source ZIP entries match the checkout and pass privacy checks.');
  }
  const archivePath = join(root, 'dist/desktop-skill/reflexrun-codex-skill.zip');
  const archive = await readFile(archivePath);
  const checksum = (await readFile(archivePath + '.sha256', 'utf8')).trim();
  assert.equal(
    checksum,
    createHash('sha256').update(archive).digest('hex') + '  reflexrun-codex-skill.zip',
  );
  const entries = unzipSync(archive);
  for (const [name, data] of Object.entries(entries)) {
    assert.match(
      name,
      /^reflexrun\/(?:SKILL\.md|LICENSE|receipt\.json|runtime\/(?:package\.json|[a-z/-]+\.js))$/,
    );
    assert.ok(!name.split('/').some((part) => part === '..' || part === 'node_modules'));
    checkPublicFile(name, data);
    const file = join(temporary, 'skill archive', name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  assert.ok(
    (await inspectDesktopSkill({ skillDirectory: join(temporary, 'skill archive/reflexrun') }))
      .ready,
  );
  console.log('Desktop ZIP checksum, contents and isolated runtime import passed.');

  const pack = JSON.parse(
    run(
      npmCommand,
      [...npmPrefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      root,
    ),
  )[0];
  for (const { path } of pack.files) {
    assert.ok(
      !/^(?:demo\/|dist\/demo\/)|^(?:dist\/)?src\/(?:engine|playwright|recorder|schema)\.|^docs\/(?:lab\.jpg|memory-dashboard\.png|native-memory\.jpg)$/.test(
        path,
      ),
      `Retired file in package: ${path}`,
    );
  }
  const unpacked = join(temporary, 'compiled package');
  await mkdir(unpacked);
  run('tar', ['-xzf', join(temporary, pack.filename), '-C', unpacked], root);
  const packageRoot = join(unpacked, 'package');
  const demoAssets = [
    'docs/playground/index.html',
    'docs/playground/app.js',
    'docs/playground/scenarios.js',
    'docs/playground/style.css',
    'docs/demo.mp4',
    'docs/demo-poster.jpg',
    'docs/logo.svg',
    'benchmarks/showcase.json',
    'benchmarks/capabilities.json',
    'LICENSE',
  ];
  for (const name of ['scripts/demo.mjs', ...demoAssets])
    assert.ok(
      pack.files.some((file) => file.path === name),
      `Missing demo asset: ${name}`,
    );
  for (const { path } of pack.files) checkPublicFile(path, await readFile(join(packageRoot, path)));
  console.log('Distribution text files passed privacy checks; synthetic fixture data is retained.');
  const demo = spawn(process.execPath, [join(packageRoot, 'scripts/demo.mjs')], {
    cwd: packageRoot,
    env: { ...process.env, REFLEXRUN_DEMO_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let timer,
      output = '';
    const ready = new Promise((resolveReady, reject) => {
      timer = setTimeout(() => reject(new Error('Packaged demo did not start')), 10_000);
      demo.once('error', reject);
      demo.once('exit', (code) => reject(new Error(`Packaged demo exited (${code})`)));
      demo.stdout.on('data', (chunk) => {
        output += chunk;
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/docs\/playground\//)?.[0];
        if (url) resolveReady(url);
      });
    });
    const url = await ready.finally(() => clearTimeout(timer));
    assert.equal((await fetch(new URL('/', url))).url, url);
    await Promise.all(
      demoAssets.map(async (name) => {
        const response = await fetch(new URL('/' + name, url));
        assert.equal(response.status, 200, name);
        if (name.endsWith('.svg'))
          assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
        assert.ok((await response.arrayBuffer()).byteLength > 0, name);
      }),
    );
    const video = await readFile(join(packageRoot, 'docs/demo.mp4'));
    for (const [range, start, end] of [
      ['bytes=0-31', 0, 31],
      ['bytes=-32', video.length - 32, video.length - 1],
    ]) {
      const response = await fetch(new URL('/docs/demo.mp4', url), { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
      assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${video.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, end + 1));
    }
    const outside = await fetch(new URL('/docs/demo.mp4', url), {
      headers: { Range: `bytes=${video.length}-` },
    });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get('Content-Range'), `bytes */${video.length}`);
    for (const path of ['/.env', '/src/cli.ts'])
      assert.equal((await fetch(new URL(path, url))).status, 404);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    console.log('Packaged demo serves only public assets without node_modules; video ranges pass.');
  } finally {
    if (demo.pid && demo.exitCode === null && demo.signalCode === null) {
      const stopped = once(demo, 'exit');
      demo.kill('SIGTERM');
      await stopped;
    }
  }
  const target = join(temporary, 'installed from package');
  const install = () =>
    run(
      process.execPath,
      [join(packageRoot, 'scripts/setup.mjs'), '--skill-directory', target],
      packageRoot,
    );
  assert.match(install(), /"installed": true/);
  const receiptBefore = await readFile(join(target, 'receipt.json'), 'utf8');
  assert.match(install(), /"installed": false/);
  assert.equal(await readFile(join(target, 'receipt.json'), 'utf8'), receiptBefore);
  assert.ok((await inspectDesktopSkill({ skillDirectory: target })).ready);
  assert.match(
    run(
      process.execPath,
      [join(packageRoot, 'dist/src/cli.js'), 'doctor', '--skill-directory', target],
      packageRoot,
    ),
    /"ready": true/,
  );
  console.log(
    'Precompiled npm package installs without a lockfile or build dependencies; repeat installation is unchanged.',
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { Reflex, ExperienceStore, observation, runMemoryBatch } = await import(
      pathToFileURL(join(process.argv[1], 'runtime/memory/index.js')));
    const store = new ExperienceStore(process.argv[2]);
    const writes = [];
    let value = '', renamed = false, text = 'Ready', repairs = 0;
    const host = {
      id: 'installed-runtime-fixture', capabilities: ['fill', 'click'],
      observe: async () => observation({ surface: 'tool', scope: 'fixture', title: '', text,
        elements: [
          { ref: 'title', role: 'textbox', name: 'Title', locator: { role: 'textbox', name: 'Title' }, value },
          { ref: 'save', role: 'button', name: renamed ? 'Confirm' : 'Save', locator: { role: 'button', name: renamed ? 'Confirm' : 'Save' } }
        ] }),
      act: async action => {
        if (action.kind === 'fill') value = action.value;
        else { writes.push(value); text = 'Saved'; }
      }
    };
    const task = (title) => ({ key: 'save', job: title, inputs: { title } });
    const first = await new Reflex({ host, store, explore: async ({ tools }) => {
      await tools.act({ kind: 'fill', target: { ref: 'title' }, input: 'title' });
      await tools.act({ kind: 'click', target: { ref: 'save' } });
      return { goal: { text: 'Saved' } };
    } }).run(task('Seed'));
    assert.equal(first.status, 'completed', first.error);
    text = 'Ready';
    const warm = await new Reflex({ host, store: new ExperienceStore(process.argv[2]) }).run(task('New input'));
    assert.equal(warm.status, 'completed', warm.error);
    assert.equal(warm.hostDelegations, 0);
    renamed = true;
    const reflex = new Reflex({ host, store, repair: async () => {
      repairs++; return [{ kind: 'click', target: { ref: 'save' } }];
    } });
    const batch = await runMemoryBatch(reflex, { id: 'installed-batch', operation: 'save',
      items: ['One', 'Two'].map(id => ({ id, label: id, facts: {}, inputs: { title: id } })),
      policy: () => ({ revision: 1, rules: [] }), verification: 'batch',
      audit: async ids => new Map(ids.map(id => [id, writes.includes(id) ? 'confirmed' : 'rejected'])) });
    assert.equal(repairs, 1);
    assert.ok(batch.rows.every(row => row.status === 'confirmed'));
    assert.deepEqual(writes, ['Seed', 'New input', 'One', 'Two']);
  `,
      target,
      join(temporary, 'isolated runtime memory'),
    ],
    temporary,
  );
  console.log(
    'Installed runtime learns, replays new inputs and repairs one item for the remaining batch without node_modules.',
  );

  const source = join(temporary, 'source checkout');
  for (const name of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'LICENSE',
    'src',
    'scripts',
    'test',
    'skills',
  ]) {
    await cp(join(root, name), join(source, name), { recursive: true });
  }
  const sourceTarget = join(temporary, 'installed from source');
  const output = run(
    npmCommand,
    [...npmPrefix, 'run', 'setup:codex', '--', '--skill-directory', sourceTarget],
    source,
    { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev' },
  );
  assert.match(output, /"installed": true/);
  assert.ok((await inspectDesktopSkill({ skillDirectory: sourceTarget })).ready);
  console.log('Clean source setup installs its compiler even in npm production mode.');

  const sourceReceipt = await readFile(join(sourceTarget, 'receipt.json'), 'utf8');
  await rm(join(source, 'node_modules/@playwright/mcp'), { recursive: true });
  const repaired = run(
    npmCommand,
    [...npmPrefix, 'run', 'setup:codex', '--', '--skill-directory', sourceTarget],
    source,
    { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev' },
  );
  assert.match(repaired, /"installed": false/);
  const restored = JSON.parse(
    await readFile(join(source, 'node_modules/@playwright/mcp/package.json'), 'utf8'),
  );
  assert.equal(restored.name, '@playwright/mcp');
  assert.equal(await readFile(join(sourceTarget, 'receipt.json'), 'utf8'), sourceReceipt);
  assert.ok((await inspectDesktopSkill({ skillDirectory: sourceTarget })).ready);
  console.log(
    'Source setup restores a missing build dependency while preserving the installed skill.',
  );
  run(npmCommand, [...npmPrefix, 'run', 'test:core'], source);
  console.log(
    'A clean source checkout passes its core workflow tests without downloading a browser.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

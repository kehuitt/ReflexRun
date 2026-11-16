import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { inspectDesktopSkill } from '../dist/src/setup.js';

const directory = fileURLToPath(new URL('../dist/desktop-skill/reflexrun/', import.meta.url));
const inspection = await inspectDesktopSkill({ skillDirectory: directory });
if (!inspection.ready) throw new Error(inspection.issues.join('\n'));
const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
const names = [...Object.keys(receipt.files), 'receipt.json'].sort();
const entries = await Promise.all(
  names.map(async (name) => ['reflexrun/' + name, await readFile(join(directory, name))]),
);
const archive = zipSync(Object.fromEntries(entries), {
  level: 6,
  mtime: new Date('2000-01-01T00:00:00Z'),
  os: 3,
  attrs: 0o100644 << 16,
});
const filename = 'reflexrun-codex-skill.zip';
const output = join(dirname(directory), filename);
await writeFile(output, archive);
await writeFile(
  output + '.sha256',
  createHash('sha256').update(archive).digest('hex') + '  ' + filename + '\n',
);
console.log(output);
console.log(output + '.sha256');

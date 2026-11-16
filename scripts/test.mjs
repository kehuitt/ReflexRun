import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join(root, 'test', name));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

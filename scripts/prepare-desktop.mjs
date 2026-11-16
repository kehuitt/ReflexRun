import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDesktopSkill } from '../dist/src/setup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'dist', 'desktop-skill', 'reflexrun');
await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(join(dirname(destination), '.prepare-'));
try {
  await installDesktopSkill({ sourceDirectory: root, skillDirectory: join(staging, 'reflexrun') });
  await rm(destination, { recursive: true, force: true });
  await rename(join(staging, 'reflexrun'), destination);
  console.log(destination);
} finally {
  await rm(staging, { recursive: true, force: true });
}

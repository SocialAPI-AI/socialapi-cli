// Runs `node --test` on every *.test.mjs file in the repo, wherever it lives.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.test.mjs') && !file.split(/[\\/]/).includes('node_modules'))
  .sort();

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;

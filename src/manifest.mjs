import { readFileSync } from 'node:fs';

/** @returns {import('../scripts/generate.mjs').Manifest} */
export function loadManifest() {
  return JSON.parse(readFileSync(new URL('../generated/commands.json', import.meta.url), 'utf8'));
}

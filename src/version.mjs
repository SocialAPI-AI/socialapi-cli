import { readFileSync } from 'node:fs';

/** The `version` of the package's own package.json. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

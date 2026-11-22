import { readFileSync } from 'node:fs';

/** @type {import('./index.mjs').Builtin} */
export const skill = {
  name: 'skill',
  usage: 'skill',
  summary: 'Print SKILL.md, the guide for AI agents that use socialapi.',
  run(args, ctx) {
    ctx.stdout.write(readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8'));
    return 0;
  },
};

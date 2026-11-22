import { VERSION } from '../version.mjs';

/** @type {import('./index.mjs').Builtin} */
export const version = {
  name: 'version',
  usage: 'version',
  summary: 'Print the version of socialapi.',
  run(args, ctx) {
    ctx.stdout.write(`${VERSION}\n`);
    return 0;
  },
};

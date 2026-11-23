// socialapi whoami: runs getCurrentUser with the resolved credential (flag, env or stored key).
import { runOperation } from '../operation.mjs';
import { findOperation } from './api.mjs';

/** @type {import('../builtins/index.mjs').Builtin} */
export const whoami = {
  name: 'whoami',
  usage: 'whoami',
  summary: 'Show the account the current API key belongs to.',
  run(args, ctx) {
    return runOperation(findOperation(ctx.manifest, 'getCurrentUser'), args, ctx);
  },
};

import { usageError } from '../errors.mjs';
import { columns, writeJson } from '../output.mjs';

/** The tag `commands` gives built-in commands. */
const BUILTIN_TAG = 'Built-in';

/** @type {import('./index.mjs').Builtin} */
export const commands = {
  name: 'commands',
  usage: 'commands [text] [--json]',
  summary: 'List the commands (API operations, then built-ins), or those whose name, tag or summary contains every word of the text.',
  run(args, ctx) {
    const options = { json: false, pretty: false };
    const words = [];
    for (const arg of args) {
      if (arg === '--json') options.json = true;
      else if (arg === '--pretty') options.pretty = true;
      else if (arg.startsWith('--')) throw usageError(`Unknown flag ${arg} for commands. Usage: socialapi commands [text] [--json]`);
      else words.push(...arg.toLowerCase().split(/\s+/).filter(Boolean));
    }
    const all = [
      ...ctx.manifest.commands.map((c) => ({ name: c.name, tag: c.tag, summary: c.summary, method: c.method, path: c.path, arguments: c.args.map((a) => a.name) })),
      ...ctx.builtins.map((b) => ({ name: b.name, tag: BUILTIN_TAG, summary: b.summary, method: null, path: null, arguments: [] })),
    ];
    const found = all.filter((c) => {
      const haystack = `${c.name} ${c.tag} ${c.summary}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    if (options.json) {
      writeJson(ctx.stdout, found, options.pretty || Boolean(ctx.stdout.isTTY));
    } else if (found.length) {
      ctx.stdout.write(`${columns(found.map((c) => [c.name, c.summary]), '')}\n`);
    }
    return 0;
  },
};

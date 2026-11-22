import { usageError } from '../errors.mjs';
import { columns, writeJson } from '../output.mjs';

/** @type {import('./index.mjs').Builtin} */
export const commands = {
  name: 'commands',
  usage: 'commands [text] [--json]',
  summary: 'List the commands, or those whose name, tag or summary contains every word of the text.',
  run(args, ctx) {
    const options = { json: false, pretty: false };
    const words = [];
    for (const arg of args) {
      if (arg === '--json') options.json = true;
      else if (arg === '--pretty') options.pretty = true;
      else if (arg.startsWith('--')) throw usageError(`Unknown flag ${arg} for commands. Usage: socialapi commands [text] [--json]`);
      else words.push(...arg.toLowerCase().split(/\s+/).filter(Boolean));
    }
    const found = ctx.manifest.commands.filter((c) => {
      const haystack = `${c.name} ${c.tag} ${c.summary}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    if (options.json) {
      const list = found.map((c) => ({ name: c.name, tag: c.tag, summary: c.summary, method: c.method, path: c.path, arguments: c.args.map((a) => a.name) }));
      writeJson(ctx.stdout, list, options.pretty || Boolean(ctx.stdout.isTTY));
    } else if (found.length) {
      ctx.stdout.write(`${columns(found.map((c) => [c.name, c.summary]), '')}\n`);
    }
    return 0;
  },
};

import { builtinHelp, commandHelp, globalHelp } from '../help.mjs';
import { unknownCommand } from '../suggest.mjs';

/** @type {import('./index.mjs').Builtin} */
export const help = {
  name: 'help',
  usage: 'help [command]',
  summary: 'Show the list of commands, or the help of one command.',
  run(args, ctx) {
    const name = args.find((a) => !a.startsWith('--'));
    const builtin = name && ctx.builtins.find((b) => b.name === name);
    const cmd = name && ctx.manifest.commands.find((c) => c.name === name);
    if (name && !builtin && !cmd) throw unknownCommand(name, ctx);
    ctx.stdout.write(builtin ? builtinHelp(builtin) : cmd ? commandHelp(cmd) : globalHelp(ctx.manifest, ctx.builtins));
    return 0;
  },
};

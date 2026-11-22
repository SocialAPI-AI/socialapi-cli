// Entry point: finds the command in argv and runs a built-in or a generated command.
import { builtins } from './builtins/index.mjs';
import { CliError, EXIT, usageError } from './errors.mjs';
import { GLOBAL_FLAGS } from './flags.mjs';
import { builtinHelp, commandHelp, globalHelp } from './help.mjs';
import { loadManifest } from './manifest.mjs';
import { runOperation } from './operation.mjs';
import { unknownCommand } from './suggest.mjs';

/**
 * @typedef {{ write(chunk: string | Uint8Array): any, isTTY?: boolean }} Output
 * @typedef {{ env: Record<string, string | undefined>, stdin: NodeJS.ReadableStream, stdout: Output, stderr: Output,
 *   manifest: import('../scripts/generate.mjs').Manifest, builtins: import('./builtins/index.mjs').Builtin[] }} Context
 */

const VALUE_GLOBALS = GLOBAL_FLAGS.filter((g) => g.type !== 'boolean').map((g) => `--${g.flag}`);

/** Index of the command name: the first token that is neither a flag nor the value of a global flag. */
function commandIndex(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return i + 1 < argv.length ? i + 1 : -1;
    if (VALUE_GLOBALS.includes(argv[i])) i++;
    else if (!argv[i].startsWith('--')) return i;
  }
  return -1;
}

/**
 * Runs the CLI and returns its exit code.
 * @param {string[]} argv
 * @param {{ env?: Context['env'], stdin?: Context['stdin'], stdout?: Output, stderr?: Output, manifest?: Context['manifest'] }} [options]
 */
export async function main(argv, options = {}) {
  /** @type {Context['manifest'] | undefined} */
  let manifest = options.manifest;
  /** @type {Context} */
  const ctx = {
    env: options.env ?? process.env,
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    get manifest() {
      manifest ??= loadManifest();
      return manifest;
    },
    builtins,
  };

  try {
    const index = commandIndex(argv);
    const wantsHelp = argv.includes('--help');
    if (index === -1) {
      if (argv.length && !wantsHelp) throw usageError('No command given. Run socialapi --help to list the commands.');
      ctx.stdout.write(globalHelp(ctx.manifest, ctx.builtins));
      return EXIT.ok;
    }
    const name = argv[index];
    const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];

    const builtin = ctx.builtins.find((b) => b.name === name);
    if (builtin) {
      if (wantsHelp) {
        ctx.stdout.write(builtinHelp(builtin));
        return EXIT.ok;
      }
      return await builtin.run(rest, ctx);
    }

    const cmd = ctx.manifest.commands.find((c) => c.name === name);
    if (cmd) {
      if (wantsHelp) {
        ctx.stdout.write(commandHelp(cmd));
        return EXIT.ok;
      }
      return await runOperation(cmd, rest, ctx);
    }

    throw unknownCommand(name, ctx);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.stderr.write(`${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`);
    return error.exitCode;
  }
}

// The single table of built-in commands. Help, `commands` and completion read it.
import { commands } from './commands.mjs';
import { completion } from './completion.mjs';
import { help } from './help.mjs';
import { skill } from './skill.mjs';
import { version } from './version.mjs';

/** Names no generated command may take. */
export const RESERVED_NAMES = ['login', 'logout', 'whoami', 'commands', 'completion', 'skill', 'help', 'version'];

/**
 * @typedef {{ name: string, usage: string, summary: string, run: (args: string[], ctx: import('../main.mjs').Context) => Promise<number> | number }} Builtin
 * @type {Builtin[]}
 */
export const builtins = [commands, completion, skill, help, version];

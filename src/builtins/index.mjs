// The single table of built-in commands. Help, `commands` and completion read it.

/** Names no generated command may take. */
export const RESERVED_NAMES = ['login', 'logout', 'whoami', 'commands', 'completion', 'skill', 'help', 'version'];

/**
 * @typedef {{ name: string, usage: string, summary: string, run: (args: string[], ctx: import('../main.mjs').Context) => Promise<number> | number }} Builtin
 * @type {Builtin[]}
 */
export const builtins = [];

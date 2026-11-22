// Help text. Generated commands use only the summaries and descriptions of the spec.
import { kebabCase } from './naming.mjs';
import { globalFlagsFor } from './operation.mjs';
import { GLOBAL_FLAGS } from './flags.mjs';
import { columns } from './output.mjs';

/** @typedef {import('../scripts/generate.mjs').Command} Command */

/** @param {import('../scripts/generate.mjs').Flag} f */
function valueHint(f) {
  if (f.file) return ' <file>';
  if (f.type === 'boolean') return '';
  if (f.type === 'array') return f.items === 'json' ? ' <json-array>' : ` <${f.items},...>`;
  if (f.type === 'object' || f.type === 'json') return ' <json>';
  return ` <${f.type}>`;
}

function globalRows(flags) {
  return flags.map((g) => [`--${g.flag}${g.value ? ` <${g.value}>` : ''}`, g.description]);
}

/**
 * @param {import('../scripts/generate.mjs').Manifest} manifest
 * @param {import('./builtins/index.mjs').Builtin[]} builtins
 */
export function globalHelp(manifest, builtins) {
  const sections = [
    'socialapi: the command-line client for the SocialAPI REST API.',
    'Usage:\n  socialapi <command> [arguments] [flags]\n  socialapi <command> --help',
  ];
  for (const tag of manifest.tags) {
    const rows = manifest.commands.filter((c) => c.tag === tag).map((c) => [c.name, c.summary]);
    sections.push(`${tag}:\n${columns(rows)}`);
  }
  sections.push(`Built-in commands:\n${columns(builtins.map((b) => [b.usage, b.summary]))}`);
  sections.push(`Global flags:\n${columns(globalRows(GLOBAL_FLAGS))}`);
  sections.push('Run socialapi <command> --help to see the arguments and flags of a command.');
  return `${sections.join('\n\n')}\n`;
}

/** @param {Command} cmd */
export function commandHelp(cmd) {
  const usage = [cmd.name, ...cmd.args.map((a) => `<${a.name}>`)].join(' ');
  const sections = [`Usage: socialapi ${usage} [flags]`];
  if (cmd.summary) sections.push(cmd.summary);
  if (cmd.description && cmd.description !== cmd.summary) sections.push(cmd.description);
  sections.push(`${cmd.method} ${cmd.path}`);

  if (cmd.args.length) {
    const rows = cmd.args.map((a) => [`<${a.name}>`, [`${a.type}, required.`, a.enum && `One of: ${a.enum.join(', ')}.`, a.description].filter(Boolean).join(' ')]);
    sections.push(`Arguments:\n${columns(rows)}`);
  }
  if (cmd.flags.length) {
    const rows = cmd.flags.map((f) => {
      const renamed = f.flag !== kebabCase(f.name);
      const details = [
        f.required && 'Required.',
        f.enum && `One of: ${f.enum.join(', ')}.`,
        f.description,
        renamed && `(Sends the ${f.in} field "${f.name}": the flag is renamed because --${kebabCase(f.name)} is taken.)`,
      ];
      return [`--${f.flag}${valueHint(f)}`, details.filter(Boolean).join(' ')];
    });
    sections.push(`Flags:\n${columns(rows)}`);
  }
  if (cmd.body) {
    sections.push(
      cmd.body.kind === 'multipart'
        ? 'Request body: multipart/form-data. File flags take a file path.'
        : 'Request body: JSON. Pass the whole body with --data; individual flags override its top-level fields.',
    );
  }
  sections.push(`Global flags:\n${columns(globalRows(globalFlagsFor(cmd)))}`);
  return `${sections.join('\n\n')}\n`;
}

/** @param {import('./builtins/index.mjs').Builtin} builtin */
export function builtinHelp(builtin) {
  return `Usage: socialapi ${builtin.usage}\n\n${builtin.summary}\n`;
}

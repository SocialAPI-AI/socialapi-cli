// Shell completion scripts built from the manifest: command names and each command's flags.
import { usageError } from '../errors.mjs';
import { globalFlagsFor } from '../operation.mjs';

const SHELLS = ['bash', 'zsh', 'fish'];

/**
 * Every completable entry: generated commands, then built-ins, each with its flags.
 * @param {import('../main.mjs').Context} ctx
 * @returns {{ name: string, summary: string, flags: string[], words?: string[] }[]}
 */
function entries(ctx) {
  const generated = ctx.manifest.commands.map((c) => ({
    name: c.name,
    summary: c.summary,
    flags: [...c.flags.map((f) => f.flag), ...globalFlagsFor(c).map((g) => g.flag)],
  }));
  const builtin = ctx.builtins.map((b) => ({
    name: b.name,
    summary: b.summary,
    flags: [...b.usage.matchAll(/--([a-z-]+)/g)].map((m) => m[1]),
    words: b.name === 'completion' ? SHELLS : b.name === 'help' ? ctx.manifest.commands.map((c) => c.name) : undefined,
  }));
  return [...generated, ...builtin];
}

const sq = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

function bash(list) {
  const cases = list.map((e) => `    ${e.name}) words="${[...(e.words ?? []), ...e.flags.map((f) => `--${f}`)].join(' ')}" ;;`);
  return `# bash completion for socialapi. Load it with: source <(socialapi completion bash)
_socialapi_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local words=""
  COMPREPLY=()
  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${list.map((e) => e.name).join(' ')}"
  else
    case "\${COMP_WORDS[1]}" in
${cases.join('\n')}
    esac
    case "$cur" in
      -*) ;;
      *) [ "$COMP_CWORD" -eq 2 ] && [ "\${COMP_WORDS[1]}" = completion -o "\${COMP_WORDS[1]}" = help ] || return 0 ;;
    esac
  fi
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F _socialapi_complete socialapi
`;
}

function zsh(list) {
  const described = list.map((e) => `    ${sq(`${e.name}:${e.summary}`)}`);
  const cases = list.map((e) => `    ${e.name}) candidates=(${[...(e.words ?? []), ...e.flags.map((f) => `--${f}`)].join(' ')}) ;;`);
  return `#compdef socialapi
# zsh completion for socialapi. Load it with: source <(socialapi completion zsh)
_socialapi() {
  local -a commands candidates
  commands=(
${described.join('\n')}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
${cases.join('\n')}
  esac
  if [[ "\${words[CURRENT]}" == -* || "\${words[2]}" == completion || "\${words[2]}" == help ]]; then
    compadd -- "\${candidates[@]}"
  else
    _files
  fi
}
compdef _socialapi socialapi
`;
}

function fish(list) {
  const q = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = [
    '# fish completion for socialapi. Load it with: socialapi completion fish | source',
    ...list.map((e) => `complete -c socialapi -n __fish_use_subcommand -f -a ${q(e.name)} -d ${q(e.summary)}`),
  ];
  for (const e of list) {
    const when = q(`__fish_seen_subcommand_from ${e.name}`);
    if (e.words) lines.push(`complete -c socialapi -n ${when} -f -a ${q(e.words.join(' '))}`);
    for (const flag of e.flags) lines.push(`complete -c socialapi -n ${when} -l ${q(flag)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** @type {import('./index.mjs').Builtin} */
export const completion = {
  name: 'completion',
  usage: 'completion bash|zsh|fish',
  summary: 'Print a shell completion script for command names and flags.',
  run(args, ctx) {
    const shell = args.find((a) => !a.startsWith('--'));
    if (!shell || !SHELLS.includes(shell)) throw usageError('Name a shell: socialapi completion bash, socialapi completion zsh or socialapi completion fish.');
    const list = entries(ctx);
    ctx.stdout.write(shell === 'bash' ? bash(list) : shell === 'zsh' ? zsh(list) : fish(list));
    return 0;
  },
};

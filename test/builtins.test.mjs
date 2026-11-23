import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../scripts/generate.mjs';
import { RESERVED_NAMES, builtins } from '../src/builtins/index.mjs';
import { run, spec, errorOf, readJson } from './helpers.mjs';

const manifest = buildManifest(spec);
const cli = (argv, options = {}) => run(argv, { manifest, ...options });
const dir = mkdtempSync(join(tmpdir(), 'socialapi-cli-completion-'));

test('socialapi, socialapi --help and socialapi help list every command grouped by tag with its summary', async () => {
  const outputs = await Promise.all([cli([]), cli(['--help']), cli(['help'])]);
  for (const result of outputs) assert.equal(result.code, 0);
  assert.equal(outputs[0].stdout, outputs[1].stdout);
  assert.equal(outputs[0].stdout, outputs[2].stdout);
  const help = outputs[0].stdout;
  for (const cmd of manifest.commands) {
    const tagStart = help.indexOf(`\n${cmd.tag}:\n`);
    assert.ok(tagStart >= 0, `tag ${cmd.tag}`);
    const section = help.slice(tagStart, help.indexOf('\n\n', tagStart + 1));
    assert.match(section, new RegExp(`\\n  ${cmd.name} +${cmd.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), cmd.name);
  }
  for (const b of builtins) assert.ok(help.includes(b.usage), b.name);
});

test('socialapi <command> --help equals socialapi help <command> and shows usage, description, arguments, flags and global flags', async () => {
  const a = await cli(['reply-to-comment', '--help']);
  const b = await cli(['help', 'reply-to-comment']);
  assert.equal(a.code, 0);
  assert.equal(a.stdout, b.stdout);
  const cmd = manifest.commands.find((c) => c.name === 'reply-to-comment');
  assert.match(a.stdout, /Usage: socialapi reply-to-comment <post_id> \[flags\]/);
  assert.ok(a.stdout.includes(cmd.description));
  assert.match(a.stdout, /Arguments:\n {2}<post_id> +string, required\./);
  assert.match(a.stdout, /--text <string>/);
  assert.match(a.stdout, /Global flags:/);
  assert.match(a.stdout, /--api-key <key>/);
  assert.ok(!a.stdout.includes('--all'), '--all only on paginated commands');
});

test('command help shows enum values, required flags and --all on paginated commands', async () => {
  const cmd = manifest.commands.find((c) => c.pagination && c.flags.some((f) => f.enum));
  const flag = cmd.flags.find((f) => f.enum);
  const result = await cli(['help', cmd.name]);
  assert.match(result.stdout, new RegExp(`--${flag.flag} .*One of: ${flag.enum.join(', ')}`));
  assert.match(result.stdout, /--all /);
  const upload = await cli(['help', 'upload-media']);
  assert.match(upload.stdout, /--file <file> +Required\./);
});

test('help shows renamed flags and the field they send', async () => {
  const fixture = buildManifest(readJson('test/fixtures/collision.json'));
  const result = await cli(['search-things', '--help'], { manifest: fixture });
  assert.match(result.stdout, /--body-limit-2 <integer> +Required\. \(Sends the body field "limit"/);
  assert.match(result.stdout, /--query-verbose +Verbose results \(Sends the query field "verbose"/);
});

test('help for an unknown command exits 2 with suggestions', async () => {
  const result = await cli(['help', 'list-acounts']);
  assert.equal(result.code, 2);
  assert.match(errorOf(result).error.message, /list-accounts/);
});

test('built-ins answer --help with their usage', async () => {
  const result = await cli(['commands', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: socialapi commands \[text\] \[--json\]/);
});

test('commands lists every command, and commands <text> searches name, tag and summary', async () => {
  const all = await cli(['commands']);
  assert.equal(all.code, 0);
  for (const cmd of manifest.commands) assert.ok(all.stdout.includes(cmd.name), cmd.name);

  const result = await cli(['commands', 'webhook']);
  assert.equal(result.code, 0);
  const expected = manifest.commands.filter((c) => `${c.name} ${c.tag} ${c.summary}`.toLowerCase().includes('webhook'));
  assert.ok(expected.length > 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, expected.length);
  for (const cmd of expected) assert.ok(result.stdout.includes(cmd.name));
  assert.ok(!result.stdout.includes('list-accounts'));
});

test('commands --json prints JSON', async () => {
  const result = await cli(['commands', 'webhook', '--json']);
  assert.equal(result.code, 0);
  const list = JSON.parse(result.stdout);
  assert.ok(Array.isArray(list) && list.length > 0);
  for (const item of list) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.summary, 'string');
    assert.equal(typeof item.tag, 'string');
  }
  assert.ok(list.some((i) => i.name === 'list-webhooks'));
});

test('commands matches every word of the text, in any order, ignoring case', async () => {
  const result = await cli(['commands', 'ACCOUNTS', 'list', '--json']);
  const names = JSON.parse(result.stdout).map((i) => i.name);
  assert.ok(names.includes('list-accounts'));
  assert.ok(!names.includes('create-post'));
});

test('version prints the package.json version', async () => {
  const result = await cli(['version']);
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `${version}\n`);
});

test('skill prints SKILL.md', async () => {
  const result = await cli(['skill']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8'));
});

test('the built-in table holds only reserved names', () => {
  for (const b of builtins) assert.ok(RESERVED_NAMES.includes(b.name), b.name);
  for (const name of ['login', 'logout', 'whoami', 'commands', 'completion', 'skill', 'help', 'version']) assert.ok(builtins.some((b) => b.name === name), name);
});

// Completion

for (const shell of ['bash', 'zsh', 'fish']) {
  test(`completion ${shell} names every command and each command's flags`, async () => {
    const result = await cli(['completion', shell]);
    assert.equal(result.code, 0, result.stderr);
    for (const cmd of manifest.commands) {
      assert.ok(result.stdout.includes(cmd.name), cmd.name);
      for (const f of cmd.flags) assert.ok(result.stdout.includes(shell === 'fish' ? `-l '${f.flag}'` : `--${f.flag}`), `${cmd.name} --${f.flag}`);
    }
    for (const b of builtins) assert.ok(result.stdout.includes(b.name), b.name);
  });
}

/** Whether a shell is installed. */
const has = (shell) => spawnSync(shell, ['-c', 'exit 0']).status === 0;

for (const [shell, args] of /** @type {[string, string[]][]} */ ([['bash', ['-n']], ['zsh', ['-n']], ['fish', ['--no-execute']]])) {
  test(`completion ${shell} parses in ${shell}`, { skip: !has(shell) && `${shell} is not installed` }, async () => {
    const result = await cli(['completion', shell]);
    const file = join(dir, `completion.${shell}`);
    writeFileSync(file, result.stdout);
    const check = spawnSync(shell, [...args, file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  });
}

test('completion bash completes command names and flags when sourced', { skip: !has('bash') && 'bash is not installed' }, async () => {
  const result = await cli(['completion', 'bash']);
  const file = join(dir, 'source.bash');
  writeFileSync(file, result.stdout);
  const script = `source ${JSON.stringify(file)}
COMP_WORDS=(socialapi list-acc); COMP_CWORD=1; _socialapi_complete; echo "\${COMPREPLY[@]}"
COMP_WORDS=(socialapi list-accounts --br); COMP_CWORD=2; _socialapi_complete; echo "\${COMPREPLY[@]}"`;
  const check = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const [names, flags] = check.stdout.trim().split('\n');
  assert.ok(names.split(' ').includes('list-accounts'));
  assert.ok(flags.split(' ').includes('--brand-id'));
});

test('completion without a known shell exits 2', async () => {
  assert.equal((await cli(['completion'])).code, 2);
  assert.equal((await cli(['completion', 'powershell'])).code, 2);
});

test('help, commands and every completion script list login, logout and whoami', async () => {
  const help = (await cli(['--help'])).stdout;
  const list = (await cli(['commands'])).stdout;
  const json = JSON.parse((await cli(['commands', '--json'])).stdout);
  for (const name of ['login', 'logout', 'whoami']) {
    assert.match(help, new RegExp(`\\n  ${name}\\b`), `help: ${name}`);
    assert.match(list, new RegExp(`^${name} `, 'm'), `commands: ${name}`);
    const item = json.find((i) => i.name === name);
    assert.ok(item, `commands --json: ${name}`);
    assert.equal(item.tag, 'Built-in');
    assert.equal(typeof item.summary, 'string');
    for (const shell of ['bash', 'zsh', 'fish']) assert.ok((await cli(['completion', shell])).stdout.includes(name), `${shell}: ${name}`);
  }
  const bash = (await cli(['completion', 'bash'])).stdout;
  assert.match(bash, /login\) words="[^"]*--with-api-key[^"]*--no-browser/);
});

test('commands <text> finds the sign-in built-ins', async () => {
  const names = JSON.parse((await cli(['commands', 'API', 'key', '--json'])).stdout).map((i) => i.name);
  assert.ok(names.includes('login'));
  assert.ok(names.includes('logout'));
});

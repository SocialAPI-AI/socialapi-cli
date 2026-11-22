// Checks on README.md, SKILL.md and hand-written text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest } from '../scripts/generate.mjs';
import { RESERVED_NAMES } from '../src/builtins/index.mjs';
import { root, spec } from './helpers.mjs';

const manifest = buildManifest(spec);
const docs = ['README.md', 'SKILL.md'].map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }));

/** The only operations hand-written code and docs may name: sign-in, and the README and SKILL.md examples. */
const NAMED_OPERATIONS = ['createApiKey', 'getCurrentUser', 'revokeApiKey', 'listAccounts', 'createPost', 'replyToComment', 'uploadMedia', 'getInboxMedia'];

test('every operation named by hand still exists in the manifest', () => {
  for (const id of NAMED_OPERATIONS) assert.ok(manifest.commands.some((c) => c.operationId === id), id);
});

for (const { name, text } of docs) {
  test(`every command named in ${name} exists`, () => {
    const named = [...text.matchAll(/(?:^|[\s`(])socialapi ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    assert.ok(named.length > 0);
    const known = new Set([...manifest.commands.map((c) => c.name), ...RESERVED_NAMES]);
    for (const command of named) assert.ok(known.has(command), `${name} names "socialapi ${command}"`);
  });

  test(`${name} has no em dash and no hard-wrapped prose`, () => {
    assert.ok(!text.includes('\u2014'), 'em dash');
    let inCode = false;
    let previousProse = false;
    for (const line of text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
      if (line.startsWith('```')) inCode = !inCode;
      const prose = !inCode && /^[A-Za-z`"(*_[]/.test(line) && !/^\*\*?[^*]+\*\*?$/.test(line);
      assert.ok(!(prose && previousProse), `hard-wrapped line in ${name}: ${line}`);
      previousProse = prose;
    }
  });
}

test('SKILL.md has front matter with a name and a description', () => {
  const text = docs.find((d) => d.name === 'SKILL.md').text;
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front);
  assert.match(front[1], /^name: \S+/m);
  assert.match(front[1], /^description: \S.+/m);
});

test('hand-written source has no em dash', () => {
  for (const dir of ['bin', 'src', 'scripts']) {
    for (const file of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.mjs')) continue;
      assert.ok(!readFileSync(join(root, dir, file), 'utf8').includes('\u2014'), `${dir}/${file}`);
    }
  }
});

test('the package ships only what the CLI needs', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'socialapi-cli');
  assert.equal(pkg.version, '0.0.0');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { socialapi: 'bin/socialapi.mjs' });
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript']);
  assert.deepEqual(pkg.files, ['bin', 'src', 'generated', 'SKILL.md']);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.publishConfig.access, 'public');
});

test('ci.yml runs generate, typecheck and tests on Node 20, 22 and 24 with read-only permissions and pinned actions', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^ {2}pull_request:/m);
  assert.match(ci, /^ {2}push:/m);
  assert.match(ci, /^permissions:\n {2}contents: read$/m);
  assert.match(ci, /node: \[20, 22, 24\]/);
  for (const step of ['npm ci', 'npm run generate', 'npm run typecheck', 'npm test']) assert.ok(ci.includes(`- run: ${step}\n`), step);
  const uses = [...ci.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, action);
});

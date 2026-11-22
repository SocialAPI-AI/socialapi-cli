import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, parseApiVersion, parseNpmView, readApiVersion, resolveRelease } from './version.mjs';

const notOnNpm = { tagExists: false, releaseExists: false };

test('parseApiVersion strips the v from a vMAJOR.MINOR.PATCH tag and its trailing newline', () => {
  assert.equal(parseApiVersion('v1.10.4\n'), '1.10.4');
  assert.equal(parseApiVersion('v0.0.1'), '0.0.1');
});

test('parseApiVersion rejects anything that is not vMAJOR.MINOR.PATCH with a clear message', () => {
  for (const text of ['1.10.4', 'v1.10', 'v1.10.4-beta.1', 'v01.2.3', 'version 1', '', 'v1.2.3\nv1.2.4', ' v1.2.3x']) {
    assert.throws(() => parseApiVersion(text), /API_VERSION must be one line of the form vMAJOR\.MINOR\.PATCH/, JSON.stringify(text));
  }
});

test('never published: publish', () => {
  assert.deepEqual(decide({ version: '1.10.4', published: [], ...notOnNpm }), {
    action: 'publish',
    version: '1.10.4',
    reason: 'socialapi-cli has never been published, 1.10.4 will be the first release.',
  });
});

test('greater than the latest published version: publish', () => {
  const decision = decide({ version: '1.10.4', published: ['0.0.0', '1.10.3'], ...notOnNpm });
  assert.equal(decision.action, 'publish');
  assert.equal(decision.reason, '1.10.4 is greater than the latest published version 1.10.3.');
});

test('numeric comparison: 1.10.0 is greater than 1.9.9', () => {
  assert.equal(decide({ version: '1.10.0', published: ['1.9.9', '1.2.0'], ...notOnNpm }).action, 'publish');
  assert.equal(decide({ version: '1.9.10', published: ['1.10.0'], ...notOnNpm }).action, 'skip');
});

test('prerelease versions on npm do not count as the latest release', () => {
  assert.equal(decide({ version: '0.0.1', published: ['0.0.0-stage', '0.0.0'], ...notOnNpm }).action, 'publish');
});

test('on npm with its tag and its GitHub Release: skip', () => {
  assert.deepEqual(decide({ version: '1.10.4', published: ['1.10.4'], tagExists: true, releaseExists: true }), {
    action: 'skip',
    version: '1.10.4',
    reason: '1.10.4 is already on npm and has its GitHub Release v1.10.4, nothing to do.',
  });
});

test('on npm with its tag but no GitHub Release: release (the Release only)', () => {
  assert.deepEqual(decide({ version: '1.10.4', published: ['1.10.4'], tagExists: true, releaseExists: false }), {
    action: 'release',
    version: '1.10.4',
    reason: '1.10.4 is already on npm and tagged v1.10.4 but its GitHub Release is missing, the Release will be created without publishing.',
  });
});

test('on npm with neither its tag nor its GitHub Release: release (tag and Release)', () => {
  assert.deepEqual(decide({ version: '1.10.4', published: ['1.10.3', '1.10.4'], tagExists: false, releaseExists: false }), {
    action: 'release',
    version: '1.10.4',
    reason: '1.10.4 is already on npm but the tag v1.10.4 and its GitHub Release are missing, they will be created without publishing.',
  });
});

test('lower than the latest published version: skip', () => {
  assert.deepEqual(decide({ version: '1.9.0', published: ['1.10.0'], ...notOnNpm }), {
    action: 'skip',
    version: '1.9.0',
    reason: '1.9.0 is not greater than the latest published version 1.10.0, nothing to publish.',
  });
});

test('parseNpmView: a 404 means never published', () => {
  const stdout = JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/socialapi-cli - Not found' } });
  assert.deepEqual(parseNpmView({ status: 1, stdout }), []);
});

test('parseNpmView: reads a list of versions, or the single version npm prints as a string', () => {
  assert.deepEqual(parseNpmView({ status: 0, stdout: '[\n  "0.0.0",\n  "1.10.4"\n]\n' }), ['0.0.0', '1.10.4']);
  assert.deepEqual(parseNpmView({ status: 0, stdout: '"0.0.0"\n' }), ['0.0.0']);
});

test('parseNpmView: any other failure is an error', () => {
  const stdout = JSON.stringify({ error: { code: 'ECONNRESET', summary: 'network' } });
  assert.throws(() => parseNpmView({ status: 1, stdout }), /could not read the published versions of socialapi-cli from npm: ECONNRESET/);
});

test('resolveRelease reads API_VERSION and asks the stubbed registry, never npm itself', async () => {
  const asked = [];
  const decision = await resolveRelease({
    apiVersionText: 'v1.10.4\n',
    lookupPublished: async () => { asked.push('npm'); return ['1.10.3']; },
    lookupTag: async () => { asked.push('tag'); return false; },
    lookupRelease: async () => { asked.push('release'); return false; },
  });
  assert.equal(decision.action, 'publish');
  assert.equal(decision.version, '1.10.4');
  assert.deepEqual(asked, ['npm']);
});

test('resolveRelease looks up the tag and the GitHub Release only when the version is already on npm', async () => {
  /** @type {string[]} */
  const asked = [];
  const decision = await resolveRelease({
    apiVersionText: 'v1.10.4\n',
    lookupPublished: async () => ['1.10.4'],
    lookupTag: async (tag) => { asked.push(`tag ${tag}`); return true; },
    lookupRelease: async (tag) => { asked.push(`release ${tag}`); return false; },
  });
  assert.equal(decision.action, 'release');
  assert.deepEqual(asked.sort(), ['release v1.10.4', 'tag v1.10.4']);
});

test('resolveRelease fails on a malformed API_VERSION before contacting the registry', async () => {
  await assert.rejects(
    resolveRelease({ apiVersionText: '1.10.4\n', lookupPublished: async () => assert.fail('registry contacted'), lookupTag: async () => false, lookupRelease: async () => false }),
    /API_VERSION must be one line of the form vMAJOR\.MINOR\.PATCH/,
  );
});

test('readApiVersion reads the version from the API_VERSION file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'api-version-')), 'API_VERSION');
  writeFileSync(file, 'v1.10.4\n');
  assert.equal(readApiVersion(file), '1.10.4');
});

test('readApiVersion explains a missing or malformed API_VERSION file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-version-'));
  assert.throws(() => readApiVersion(join(dir, 'API_VERSION')), /^Error: API_VERSION is missing\. It arrives with the first spec push from an API release/);
  writeFileSync(join(dir, 'API_VERSION'), 'latest\n');
  assert.throws(() => readApiVersion(join(dir, 'API_VERSION')), /API_VERSION must be one line of the form vMAJOR\.MINOR\.PATCH/);
});

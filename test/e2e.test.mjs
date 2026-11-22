// A handful of tests that spawn the real binary against the fake API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './helpers.mjs';

const bin = fileURLToPath(new URL('../bin/socialapi.mjs', import.meta.url));

/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(() => api.reset());

/**
 * @param {string[]} args
 * @param {{ stdin?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
function socialapi(args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', SOCIALAPI_BASE_URL: api.baseUrl, SOCIALAPI_API_KEY: 'sapi_key_e2e', ...options.env };
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: 'pipe' });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(options.stdin ?? '');
  });
}

test('socialapi list-accounts', async () => {
  api.respond({ body: { data: [{ id: 'acc_1' }] } });
  const result = await socialapi(['list-accounts']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString(), '{"data":[{"id":"acc_1"}]}\n');
  assert.equal(api.requests[0].path, '/v1/accounts');
  assert.equal(api.requests[0].headers.authorization, 'Bearer sapi_key_e2e');
});

test('socialapi create-post --text "Hi" --targets ...', async () => {
  const result = await socialapi(['create-post', '--text', 'Hi', '--targets', '[{"account_id":"a1"},{"account_id":"a2"}]']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].method, 'POST');
  assert.equal(api.requests[0].path, '/v1/posts');
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()), { text: 'Hi', targets: [{ account_id: 'a1' }, { account_id: 'a2' }] });
});

test('socialapi reply-to-comment <post_id> --text "Thanks"', async () => {
  const result = await socialapi(['reply-to-comment', 'p_1', '--text', 'Thanks']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].path, '/v1/inbox/comments/p_1');
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()), { text: 'Thanks' });
});

test('--data - reads the body from stdin of the real process', async () => {
  const result = await socialapi(['reply-to-comment', 'p_1', '--data', '-'], { stdin: '{"text":"piped"}' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()), { text: 'piped' });
});

test('a binary response is written to a piped stdout byte for byte', async () => {
  const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
  api.respond({ headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  const result = await socialapi(['get-inbox-media', 'med_1']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout, bytes);
});

test('an API error exits 1, a usage error exits 2, an unreachable API exits 3', async () => {
  api.respond({ status: 401, body: '{"error":{"code":"auth.invalid_key","message":"Invalid API key"},"request_id":"r1"}' });
  const apiError = await socialapi(['list-accounts']);
  assert.equal(apiError.code, 1);
  assert.equal(apiError.stderr, '{"error":{"code":"auth.invalid_key","message":"Invalid API key"},"request_id":"r1"}\n');

  const usage = await socialapi(['nope-command']);
  assert.equal(usage.code, 2);
  assert.equal(JSON.parse(usage.stderr).error.code, 'invalid_usage');

  const closed = await startFakeApi();
  await closed.close();
  const unreachable = await socialapi(['list-accounts'], { env: { SOCIALAPI_BASE_URL: closed.baseUrl } });
  assert.equal(unreachable.code, 3);
  assert.equal(JSON.parse(unreachable.stderr).error.code, 'network_error');
});

test('socialapi version prints the package.json version', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await socialapi(['version']);
  assert.equal(result.stdout.toString(), `${version}\n`);
});

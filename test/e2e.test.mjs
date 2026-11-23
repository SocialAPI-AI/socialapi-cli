// A handful of tests that spawn the real binary against the fake API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, tempConfigHome } from './helpers.mjs';

const bin = fileURLToPath(new URL('../bin/socialapi.mjs', import.meta.url));

/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let api;
const configHome = tempConfigHome();
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(() => api.reset());

/**
 * @param {string[]} args
 * @param {{ stdin?: string, env?: Record<string, string | undefined>, onStderr?: (text: string) => void }} [options]
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
function socialapi(args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', SOCIALAPI_BASE_URL: api.baseUrl, SOCIALAPI_API_KEY: 'sapi_key_e2e', XDG_CONFIG_HOME: configHome, APPDATA: configHome, ...options.env };
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: 'pipe' });
    const timer = setTimeout(() => child.kill(), 20_000);
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => {
      err.push(c);
      options.onStderr?.(Buffer.concat(err).toString());
    });
    child.on('exit', () => clearTimeout(timer));
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

test('socialapi login --no-browser prints the authorize URL on stderr, and following it stores a key that later commands send', async () => {
  const auth = await startFakeApi({ oauth: true });
  const home = tempConfigHome();
  const env = { SOCIALAPI_BASE_URL: auth.baseUrl, SOCIALAPI_API_KEY: undefined, XDG_CONFIG_HOME: home, APPDATA: home };
  try {
    let visit;
    const login = await socialapi(['login', '--no-browser'], {
      env,
      onStderr(text) {
        const url = text.match(/^https?:\/\/\S+$/m)?.[0];
        if (url && !visit) visit = fetch(url);
      },
    });
    assert.equal((await visit)?.status, 200);
    assert.equal(login.code, 0, login.stderr);
    assert.deepEqual(JSON.parse(login.stdout.toString()), { logged_in: true, base_url: auth.baseUrl, user: auth.auth.user });
    const stored = JSON.parse(readFileSync(join(home, 'socialapi', 'config.json'), 'utf8'));
    assert.equal(stored.created_by_login, true);

    const whoami = await socialapi(['whoami'], { env });
    assert.equal(whoami.code, 0, whoami.stderr);
    assert.equal(auth.requests.at(-1)?.headers.authorization, `Bearer ${stored.api_key}`);

    const logout = await socialapi(['logout'], { env });
    assert.equal(logout.code, 0, logout.stderr);
    assert.ok(!existsSync(join(home, 'socialapi', 'config.json')));
    for (const secret of auth.auth.secrets) assert.ok(![login, whoami, logout].some((r) => r.stdout.toString().includes(secret) || r.stderr.includes(secret)));
  } finally {
    await auth.close();
  }
});

test('echo <key> | socialapi login --with-api-key verifies and stores the key', async () => {
  const auth = await startFakeApi({ oauth: true });
  const home = tempConfigHome();
  try {
    const key = auth.auth.addKey();
    const result = await socialapi(['login', '--with-api-key'], { env: { SOCIALAPI_BASE_URL: auth.baseUrl, SOCIALAPI_API_KEY: undefined, XDG_CONFIG_HOME: home }, stdin: `${key}\n` });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(auth.requests[0].headers.authorization, `Bearer ${key}`);
    const stored = JSON.parse(readFileSync(join(home, 'socialapi', 'config.json'), 'utf8'));
    assert.deepEqual(stored, { base_url: auth.baseUrl, api_key: key, key_id: null, created_by_login: false });
    assert.ok(!result.stdout.toString().includes(key) && !result.stderr.includes(key));
  } finally {
    await auth.close();
  }
});

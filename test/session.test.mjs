// After sign-in: the stored key in use (credential order), socialapi whoami and socialapi logout.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildManifest } from '../scripts/generate.mjs';
import { configPath, readConfig, writeConfig } from '../src/auth/config.mjs';
import { errorOf, run, spec, startFakeApi, tempConfigHome } from './helpers.mjs';

const manifest = buildManifest(spec);

/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let api;
/** @type {Record<string, string>} */
let env;
before(async () => {
  api = await startFakeApi({ oauth: true });
});
after(() => api.close());
beforeEach(() => {
  api.reset();
  api.auth.failKeyDeletion = false;
  env = { SOCIALAPI_BASE_URL: api.baseUrl, XDG_CONFIG_HOME: tempConfigHome() };
});

const cli = (argv, options = {}) => run(argv, { env, manifest, ...options });

/** Signs in through the browser flow, following the printed URL, and returns the stored entry. */
async function browserLogin() {
  let visit;
  const result = await cli(['login', '--no-browser'], {
    loginTimeoutMs: 5000,
    onStderr(text) {
      const url = text.match(/^https?:\/\/\S+$/m)?.[0];
      if (url && !visit) visit = fetch(url);
    },
  });
  await visit;
  assert.equal(result.code, 0, result.stderr);
  api.reset();
  return readConfig(env);
}

/** Stores a key as `login --with-api-key` would. */
function storePastedKey() {
  const key = api.auth.addKey();
  writeConfig(env, { base_url: api.baseUrl, api_key: key, key_id: null, created_by_login: false });
  return key;
}

function assertNoSecret(text) {
  for (const secret of api.auth.secrets) assert.ok(!text.includes(secret), 'a secret leaked');
}

// The stored key in the credential order

test('after login, a command with no flag and no env var sends the stored key', async () => {
  const stored = await browserLogin();
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].path, '/v1/accounts');
  assert.equal(api.requests[0].headers.authorization, `Bearer ${stored.api_key}`);
});

test('SOCIALAPI_API_KEY wins over the stored key, and --api-key wins over both', async () => {
  await browserLogin();
  await cli(['list-accounts'], { env: { ...env, SOCIALAPI_API_KEY: 'sapi_key_from_env' } });
  assert.equal(api.requests[0].headers.authorization, 'Bearer sapi_key_from_env');
  await cli(['list-accounts', '--api-key', 'sapi_key_from_flag'], { env: { ...env, SOCIALAPI_API_KEY: 'sapi_key_from_env' } });
  assert.equal(api.requests[1].headers.authorization, 'Bearer sapi_key_from_flag');
});

test('with another --base-url the stored key is not sent and the command exits 2 with no_credential', async () => {
  await browserLogin();
  const result = await cli(['list-accounts', '--base-url', `http://localhost:${api.port}/v1`]);
  assert.equal(result.code, 2);
  const error = errorOf(result).error;
  assert.equal(error.code, 'no_credential');
  assert.match(error.message, /socialapi login/);
  assert.match(error.message, /SOCIALAPI_API_KEY/);
  assert.equal(api.requests.length, 0);
});

test('--verbose never shows the stored key', async () => {
  await browserLogin();
  const result = await cli(['list-accounts', '--verbose']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /socialapi: > GET/);
  assertNoSecret(result.stdout + result.stderr);
});

// whoami

test('whoami prints the current user for the stored key', async () => {
  const key = storePastedKey();
  const result = await cli(['whoami']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), api.auth.user);
  assert.equal(api.requests[0].path, '/v1/users/me');
  assert.equal(api.requests[0].headers.authorization, `Bearer ${key}`);
  assertNoSecret(result.stdout + result.stderr);
});

test('whoami uses SOCIALAPI_API_KEY and --api-key', async () => {
  const envKey = api.auth.addKey();
  const flagKey = api.auth.addKey();
  assert.equal((await cli(['whoami'], { env: { ...env, SOCIALAPI_API_KEY: envKey } })).code, 0);
  assert.equal(api.requests[0].headers.authorization, `Bearer ${envKey}`);
  const result = await cli(['whoami', '--api-key', flagKey, '--verbose'], { env: { ...env, SOCIALAPI_API_KEY: envKey } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), api.auth.user);
  assert.equal(api.requests[1].headers.authorization, `Bearer ${flagKey}`);
  assertNoSecret(result.stdout + result.stderr);
});

test('whoami with no credential exits 2 with no_credential naming socialapi login', async () => {
  const result = await cli(['whoami']);
  assert.equal(result.code, 2);
  assert.match(errorOf(result).error.message, /socialapi login/);
  assert.equal(errorOf(result).error.code, 'no_credential');
  assert.equal(api.requests.length, 0);
});

test('whoami with a key the API refuses prints the API error and exits 1', async () => {
  const result = await cli(['whoami', '--api-key', 'sapi_key_unknown']);
  assert.equal(result.code, 1);
  assert.equal(errorOf(result).error.code, 'auth.invalid_key');
});

// logout

test('logout after a browser login deletes the key on the API and removes it locally', async () => {
  const stored = await browserLogin();
  const result = await cli(['logout']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { logged_out: true, base_url: api.baseUrl, key_deleted: true });
  const deletion = api.requests.find((r) => r.method === 'DELETE');
  assert.equal(deletion?.path, `/v1/keys/${stored.key_id}`);
  assert.equal(deletion.headers.authorization, `Bearer ${stored.api_key}`);
  assert.equal(api.auth.keys.has(stored.api_key), false);
  assert.equal(existsSync(configPath(env)), false);
  assertNoSecret(result.stdout + result.stderr);
});

test('logout after login --with-api-key only removes the key locally', async () => {
  const key = storePastedKey();
  const result = await cli(['logout']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { logged_out: true, base_url: api.baseUrl, key_deleted: false });
  assert.equal(api.requests.length, 0);
  assert.ok(api.auth.keys.has(key));
  assert.equal(existsSync(configPath(env)), false);
});

test('when the API deletion fails, logout still removes the key locally and exits 1 pointing to the dashboard', async () => {
  await browserLogin();
  api.auth.failKeyDeletion = true;
  const result = await cli(['logout']);
  assert.equal(result.code, 1);
  const error = errorOf(result).error;
  assert.equal(error.code, 'key_not_deleted');
  assert.match(error.message, /dashboard/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(configPath(env)), false);
  assertNoSecret(result.stderr);
});

test('when the API no longer knows the key, logout counts it as deleted', async () => {
  const stored = await browserLogin();
  api.auth.keys.delete(stored.api_key);
  const result = await cli(['logout']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).logged_out, true);
  assert.equal(existsSync(configPath(env)), false);
});

test('logout with nothing stored exits 0 and says so', async () => {
  const result = await cli(['logout']);
  assert.equal(result.code, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.logged_out, false);
  assert.equal(typeof answer.message, 'string');
  assert.equal(api.requests.length, 0);
});

test('logout rejects an unknown flag', async () => {
  const result = await cli(['logout', '--everywhere']);
  assert.equal(result.code, 2);
  assert.equal(errorOf(result).error.code, 'invalid_usage');
});

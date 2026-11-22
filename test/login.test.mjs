// socialapi login: the browser flow against the fake OAuth server, and --with-api-key.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { buildManifest } from '../scripts/generate.mjs';
import { configPath, readConfig, writeConfig } from '../src/auth/config.mjs';
import { SIGN_IN_OPERATIONS } from '../src/auth/api.mjs';
import { browserCommand } from '../src/auth/login.mjs';
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
  Object.assign(api.auth, { discovery: {}, consent: 'approve', failKeyDeletion: false });
  api.auth.revoked.length = 0;
  env = { SOCIALAPI_BASE_URL: api.baseUrl, XDG_CONFIG_HOME: tempConfigHome() };
});

const paths = () => api.requests.map((r) => `${r.method} ${r.path}`);
const requestTo = (method, path) => api.requests.find((r) => r.method === method && r.path === path);
const form = (req) => new URLSearchParams(req.body.toString());

/**
 * Runs `socialapi login --no-browser ...` and, like a person in a browser, follows the URL it prints on stderr.
 * @param {string[]} [argv]
 * @param {{ follow?: boolean, loginTimeoutMs?: number, stdin?: string, env?: Record<string, string> }} [options]
 */
async function login(argv = [], options = {}) {
  let authorizeUrl;
  /** @type {Promise<Response> | undefined} */
  let visit;
  const result = await run(['login', '--no-browser', ...argv], {
    env: options.env ?? env,
    manifest,
    stdin: options.stdin,
    loginTimeoutMs: options.loginTimeoutMs ?? 5000,
    onStderr(text) {
      const url = text.match(/^https?:\/\/\S+$/m)?.[0];
      if (url && !authorizeUrl) {
        authorizeUrl = url;
        if (options.follow !== false) visit = fetch(url);
      }
    },
  });
  const callback = visit && (await visit);
  return { ...result, authorizeUrl, callback, callbackText: callback && (await callback.text()) };
}

/** Asserts that no secret the fake server handed out appears in the text. */
function assertNoSecret(text) {
  for (const secret of api.auth.secrets) assert.ok(!text.includes(secret), `a secret (${secret.split('_').slice(0, -1).join('_')}) leaked`);
}

test('the operations sign-in needs exist in the manifest', () => {
  for (const id of SIGN_IN_OPERATIONS) {
    assert.ok(manifest.commands.some((c) => c.operationId === id), `sign-in needs the operation ${id}, which the spec no longer has`);
  }
  assert.deepEqual([...SIGN_IN_OPERATIONS].sort(), ['createApiKey', 'getCurrentUser', 'revokeApiKey']);
});

for (const id of ['createApiKey', 'getCurrentUser', 'revokeApiKey']) {
  test(`with no ${id} in the manifest, login stops with unsupported_api before any request`, async () => {
    const without = { ...manifest, commands: manifest.commands.filter((c) => c.operationId !== id) };
    const result = await run(['login', '--no-browser'], { env, manifest: without, loginTimeoutMs: 1000 });
    assert.equal(result.code, 2, result.stderr);
    const error = errorOf(result).error;
    assert.equal(error.code, 'unsupported_api');
    assert.ok(error.message.includes(id));
    assert.equal(api.requests.length, 0);
  });
}

test('login --no-browser prints the authorize URL on stderr, and following it signs in', async () => {
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  const authorize = new URL(result.authorizeUrl);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${api.origin}/oauth/authorize`);
  assert.equal(result.callback.status, 200);
  assert.match(result.callbackText, /signed in/i);

  assert.deepEqual(JSON.parse(result.stdout), { logged_in: true, base_url: api.baseUrl, user: api.auth.user });
  assert.deepEqual(paths(), [
    'GET /.well-known/oauth-authorization-server',
    'POST /oauth/register',
    'GET /oauth/authorize',
    'POST /oauth/token',
    'POST /v1/keys',
    'GET /v1/users/me',
    'POST /oauth/revoke',
    'POST /oauth/revoke',
  ]);
});

test('login registers a client for the exact loopback callback and authorizes with PKCE S256, a state and scope social:all', async () => {
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  const register = JSON.parse(requestTo('POST', '/oauth/register').body.toString());
  assert.match(register.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(typeof register.client_name, 'string');

  const authorize = requestTo('GET', '/oauth/authorize').query;
  assert.equal(authorize.get('redirect_uri'), register.redirect_uris[0]);
  assert.equal(authorize.get('code_challenge_method'), 'S256');
  assert.equal(authorize.get('response_type'), 'code');
  assert.equal(authorize.get('scope'), 'social:all');
  assert.ok((authorize.get('state') ?? '').length >= 16);
  assert.ok((authorize.get('code_challenge') ?? '').length >= 43);

  const token = form(requestTo('POST', '/oauth/token'));
  assert.equal(token.get('grant_type'), 'authorization_code');
  assert.equal(token.get('redirect_uri'), register.redirect_uris[0]);
  assert.ok(token.get('client_secret'), 'client_secret_post');
});

test('login creates a named API key with the OAuth access token, verifies it, stores it and revokes both OAuth tokens', async () => {
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  const create = requestTo('POST', '/v1/keys');
  const accessToken = create.headers.authorization.replace('Bearer ', '');
  assert.ok(accessToken.startsWith('oauth_access_'));
  assert.deepEqual(JSON.parse(create.body.toString()), { name: `SocialAPI CLI (${hostname()})` });

  const stored = readConfig(env);
  assert.ok(stored);
  assert.equal(stored.created_by_login, true);
  assert.equal(stored.base_url, api.baseUrl);
  assert.equal(api.auth.keys.get(stored.api_key), stored.key_id);
  assert.equal(requestTo('GET', '/v1/users/me').headers.authorization, `Bearer ${stored.api_key}`);

  assert.equal(api.auth.accessTokens.size, 0);
  assert.equal(api.auth.refreshTokens.size, 0);
  assert.equal(api.auth.revoked.length, 2);
  assert.ok(api.auth.revoked.includes(accessToken));
});

test('the stored file holds only the key entry, with mode 0600 in a 0700 directory', { skip: process.platform === 'win32' }, async () => {
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  const file = configPath(env);
  const raw = readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['api_key', 'base_url', 'created_by_login', 'key_id']);
  for (const secret of api.auth.secrets.filter((s) => !s.startsWith('sapi_key_'))) assert.ok(!raw.includes(secret), 'no OAuth token or client secret on disk');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
});

test('login never prints the API key, the OAuth tokens or the client secret, even with --verbose', async () => {
  const result = await login(['--verbose']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /socialapi: > POST/);
  assertNoSecret(result.stdout);
  assertNoSecret(result.stderr);
});

test('login prints pretty JSON with --pretty', async () => {
  const result = await login(['--pretty']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('\n  "logged_in": true'));
});

// Failures: the documented error and exit code, and nothing stored.

function assertNothingStored() {
  assert.equal(existsSync(configPath(env)), false);
}

test('a callback with another state exits 1 with invalid_state and exchanges no code', async () => {
  api.auth.consent = 'wrong_state';
  const result = await login();
  assert.equal(result.code, 1, result.stderr);
  assert.equal(errorOf(result).error.code, 'invalid_state');
  assert.equal(result.stdout, '');
  assert.ok(!requestTo('POST', '/oauth/token'));
  assertNothingStored();
});

test('a refused consent exits 1 with the OAuth error', async () => {
  api.auth.consent = 'deny';
  const result = await login();
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(errorOf(result), { error: { code: 'access_denied', message: 'The user denied access.' } });
  assert.match(result.callbackText, /access_denied|not signed in/i);
  assert.ok(!requestTo('POST', '/oauth/token'));
  assertNothingStored();
});

test('no callback within the time limit exits 2 with login_timeout and closes the callback port', async () => {
  const result = await login([], { follow: false, loginTimeoutMs: 200 });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(errorOf(result).error.code, 'login_timeout');
  assertNothingStored();
  const redirectUri = JSON.parse(requestTo('POST', '/oauth/register').body.toString()).redirect_uris[0];
  await assert.rejects(fetch(redirectUri));
});

test('a discovery document with an endpoint on another origin stops login before any registration', async () => {
  api.auth.discovery = { token_endpoint: 'https://elsewhere.example.com/oauth/token' };
  const result = await login();
  assert.equal(result.code, 1, result.stderr);
  const error = errorOf(result).error;
  assert.equal(error.code, 'invalid_authorization_server');
  assert.match(error.message, /elsewhere\.example\.com/);
  assert.equal(result.authorizeUrl, undefined);
  assert.deepEqual(paths(), ['GET /.well-known/oauth-authorization-server']);
  assertNothingStored();
});

test('a discovery document without a required endpoint stops login', async () => {
  api.auth.discovery = { revocation_endpoint: undefined };
  const result = await login();
  assert.equal(result.code, 1, result.stderr);
  assert.equal(errorOf(result).error.code, 'invalid_authorization_server');
  assertNothingStored();
});

test('login to a base URL that is neither https nor localhost exits 2 with insecure_base_url and sends nothing', async () => {
  const result = await login(['--base-url', 'http://api.example.com/v1']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(errorOf(result).error.code, 'insecure_base_url');
  assert.equal(api.requests.length, 0);
});

test('login rejects an unknown flag', async () => {
  const result = await login(['--profile', 'work']);
  assert.equal(result.code, 2);
  assert.equal(errorOf(result).error.code, 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

// Replacing an earlier login

test('a second login replaces the stored key and deletes the key the first login created', async () => {
  assert.equal((await login()).code, 0);
  const first = readConfig(env);
  api.reset();
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  const second = readConfig(env);
  assert.notEqual(second.api_key, first.api_key);
  const deletion = requestTo('DELETE', `/v1/keys/${first.key_id}`);
  assert.ok(deletion, 'the previous key is deleted');
  assert.equal(deletion.headers.authorization, `Bearer ${first.api_key}`);
  assert.equal(api.auth.keys.has(first.api_key), false);
  assert.equal(api.auth.keys.has(second.api_key), true);
});

test('when deleting the previous key fails, login still succeeds and says so on stderr', async () => {
  assert.equal((await login()).code, 0);
  const first = readConfig(env);
  api.auth.failKeyDeletion = true;
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(readConfig(env).api_key, first.api_key);
  assert.match(result.stderr, /previous API key/);
  assert.match(result.stderr, /dashboard/);
  assertNoSecret(result.stderr);
});

test('a login does not delete a stored key it did not create', async () => {
  const pasted = api.auth.addKey();
  writeConfig(env, { base_url: api.baseUrl, api_key: pasted, key_id: null, created_by_login: false });
  const result = await login();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!api.requests.some((r) => r.method === 'DELETE'));
  assert.ok(api.auth.keys.has(pasted));
});

// --with-api-key

test('login --with-api-key reads the key from stdin, verifies it and stores it as not created by login', async () => {
  const key = api.auth.addKey();
  const result = await login(['--with-api-key'], { stdin: `${key}\n` });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { logged_in: true, base_url: api.baseUrl, user: api.auth.user });
  assert.deepEqual(paths(), ['GET /v1/users/me']);
  assert.equal(api.requests[0].headers.authorization, `Bearer ${key}`);
  assert.deepEqual(readConfig(env), { base_url: api.baseUrl, api_key: key, key_id: null, created_by_login: false });
  assertNoSecret(result.stdout + result.stderr);
});

test('login --with-api-key with an invalid key shows the API error, exits 1 and stores nothing', async () => {
  const result = await login(['--with-api-key'], { stdin: 'sapi_key_not_valid\n' });
  assert.equal(result.code, 1);
  assert.deepEqual(errorOf(result), { error: { code: 'auth.invalid_key', message: 'Invalid API key' }, request_id: 'req_test_1' });
  assert.equal(result.stdout, '');
  assertNothingStored();
});

test('login --with-api-key with an empty stdin exits 2', async () => {
  const result = await login(['--with-api-key'], { stdin: '\n' });
  assert.equal(result.code, 2);
  assert.equal(errorOf(result).error.code, 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

// Opening the browser (the command only; tests never open one)

test('the browser is opened with open on macOS, xdg-open on Linux and start on Windows', () => {
  const url = 'https://api.example.com/oauth/authorize?a=1&b=2';
  assert.deepEqual(browserCommand('darwin', url), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand('linux', url), { command: 'xdg-open', args: [url] });
  const windows = browserCommand('win32', url);
  assert.equal(windows.command, 'cmd');
  assert.ok(windows.args.includes('start'));
  assert.ok(windows.args.some((a) => a.includes(url)));
});

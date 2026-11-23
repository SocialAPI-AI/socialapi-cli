// Shared test helpers: the spec, the fake API server and an in-process runner.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../src/main.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** @param {string} path relative to the repo root */
export function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

export const spec = readJson('openapi.json');

/** A new empty directory to use as XDG_CONFIG_HOME (and APPDATA), so no test reads or writes the real config. */
export const tempConfigHome = () => mkdtempSync(join(tmpdir(), 'socialapi-cli-config-'));

/** One shared config home for tests that do not pass their own. */
const defaultConfigHome = tempConfigHome();

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** Every operation of a spec, read straight from its paths. */
export function operations(doc) {
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      if (item[method]) ops.push({ method, path, operation: item[method], pathItem: item });
    }
  }
  return ops;
}

/**
 * @typedef {{ status?: number, headers?: Record<string, string>, body?: any, delayMs?: number }} ScriptedResponse
 * @typedef {{ method: string, path: string, query: URLSearchParams, headers: import('node:http').IncomingHttpHeaders, body: Buffer }} RecordedRequest
 */

/**
 * The OAuth 2.1 server and the API key operations sign-in uses, for a fake API started with `{ oauth: true }`.
 * It checks what a real server checks (registered redirect URI, PKCE S256, client secret, bearer tokens) and
 * remembers every secret it hands out, so tests can assert none of them leaks.
 * @param {string} origin
 */
function fakeAuthServer(origin) {
  const secret = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;
  const state = {
    /** Fields merged over the discovery document. */
    discovery: /** @type {Record<string, any>} */ ({}),
    /** What the consent page does: approve, deny, answer with another state, or never come back. */
    consent: /** @type {'approve' | 'deny' | 'wrong_state' | 'never'} */ ('approve'),
    /** When true, deleting a key answers 500. */
    failKeyDeletion: false,
    user: { id: 'usr_1', email: 'ana@example.com', name: 'Ana' },
    /** @type {Map<string, { secret: string, redirectUri: string }>} */
    clients: new Map(),
    /** @type {Map<string, { clientId: string, redirectUri: string, challenge: string }>} */
    codes: new Map(),
    /** Active OAuth access and refresh tokens. */
    accessTokens: new Set(),
    refreshTokens: new Set(),
    /** Revoked OAuth tokens, in order. */
    revoked: /** @type {string[]} */ ([]),
    /** Active API keys: raw key to key id. */
    keys: /** @type {Map<string, string>} */ (new Map()),
    /** Every secret ever handed out: client secrets, codes, tokens and raw keys. */
    secrets: /** @type {string[]} */ ([]),
    /** Adds an active API key and returns it. */
    addKey(raw = secret('sapi_key_')) {
      state.keys.set(raw, `key_${state.keys.size + 1}_${randomBytes(3).toString('hex')}`);
      state.secrets.push(raw);
      return raw;
    },
  };
  const json = (status, body) => ({ status, body });
  const oauthError = (error, description) => json(400, { error, error_description: description });
  const apiError = (status, code, message) => json(status, { error: { code, message }, request_id: 'req_test_1' });
  const bearer = (headers) => String(headers.authorization ?? '').replace(/^Bearer /, '');
  const form = (body) => new URLSearchParams(body.toString());
  const clientOk = (params) => state.clients.get(params.get('client_id') ?? '')?.secret === params.get('client_secret');

  /**
   * @param {string} method
   * @param {URL} url
   * @param {import('node:http').IncomingHttpHeaders} headers
   * @param {Buffer} body
   * @returns {ScriptedResponse | undefined} undefined when the request is not one of these routes
   */
  function handle(method, url, headers, body) {
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        scopes_supported: ['social:all'],
        ...state.discovery,
      });
    }
    if (route === 'POST /oauth/register') {
      const request = JSON.parse(body.toString() || '{}');
      if (!request.client_name || !Array.isArray(request.redirect_uris) || request.redirect_uris.length !== 1) return oauthError('invalid_client_metadata', 'client_name and redirect_uris are required');
      const clientId = secret('client_');
      const clientSecret = secret('client_secret_');
      state.clients.set(clientId, { secret: clientSecret, redirectUri: request.redirect_uris[0] });
      state.secrets.push(clientSecret);
      return json(201, { client_id: clientId, client_secret: clientSecret, client_name: request.client_name, redirect_uris: request.redirect_uris, token_endpoint_auth_method: 'client_secret_post' });
    }
    if (route === 'GET /oauth/authorize') {
      const q = url.searchParams;
      const client = state.clients.get(q.get('client_id') ?? '');
      if (!client || client.redirectUri !== q.get('redirect_uri')) return oauthError('invalid_request', 'unknown client or redirect_uri');
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || q.get('scope') !== 'social:all') {
        return oauthError('invalid_request', 'response_type, PKCE S256, state and scope are required');
      }
      if (state.consent === 'never') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>Consent page</p>' };
      const back = new URL(client.redirectUri);
      if (state.consent === 'deny') {
        back.search = new URLSearchParams({ error: 'access_denied', error_description: 'The user denied access.', state: q.get('state') ?? '' }).toString();
      } else {
        const code = secret('code_');
        state.codes.set(code, { clientId: q.get('client_id') ?? '', redirectUri: client.redirectUri, challenge: q.get('code_challenge') ?? '' });
        state.secrets.push(code);
        back.search = new URLSearchParams({ code, state: state.consent === 'wrong_state' ? 'not-the-state-sent' : q.get('state') ?? '' }).toString();
      }
      return { status: 302, headers: { location: back.href }, body: '' };
    }
    if (route === 'POST /oauth/token') {
      const params = form(body);
      if (!clientOk(params)) return json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
      const grant = state.codes.get(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (params.get('grant_type') !== 'authorization_code' || !grant || grant.clientId !== params.get('client_id') || grant.redirectUri !== params.get('redirect_uri') || grant.challenge !== challenge) {
        return oauthError('invalid_grant', 'the code, redirect_uri or code_verifier does not match');
      }
      state.codes.delete(params.get('code') ?? '');
      const access = secret('oauth_access_');
      const refresh = secret('oauth_refresh_');
      state.accessTokens.add(access);
      state.refreshTokens.add(refresh);
      state.secrets.push(access, refresh);
      return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'social:all' });
    }
    if (route === 'POST /oauth/revoke') {
      const params = form(body);
      if (!clientOk(params)) return json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
      const token = params.get('token') ?? '';
      state.accessTokens.delete(token);
      state.refreshTokens.delete(token);
      state.revoked.push(token);
      return { status: 200, body: '' };
    }
    const authorized = state.accessTokens.has(bearer(headers)) || state.keys.has(bearer(headers));
    if (route === 'POST /v1/keys') {
      if (!authorized) return apiError(401, 'auth.invalid_key', 'Invalid API key');
      const request = JSON.parse(body.toString() || '{}');
      const raw = state.addKey();
      return json(201, { id: state.keys.get(raw), name: request.name, raw_key: raw, scopes: null, brand_ids: null, message: 'Store this key securely. It will not be shown again.' });
    }
    if (route === 'GET /v1/users/me') {
      if (!authorized) return apiError(401, 'auth.invalid_key', 'Invalid API key');
      return json(200, state.user);
    }
    const deletion = route.match(/^DELETE \/v1\/keys\/([^/]+)$/);
    if (deletion) {
      if (state.failKeyDeletion) return apiError(500, 'internal_error', 'Something went wrong');
      if (!authorized) return apiError(401, 'auth.invalid_key', 'Invalid API key');
      const raw = [...state.keys].find(([, id]) => id === decodeURIComponent(deletion[1]))?.[0];
      if (!raw) return apiError(404, 'key.not_found', 'API key not found');
      state.keys.delete(raw);
      return json(200, { ok: true });
    }
    return undefined;
  }
  return { state, handle };
}

/**
 * A fake API on 127.0.0.1 (random port) that records requests and plays scripted responses.
 * With `{ oauth: true }` it also serves the OAuth server and the key operations sign-in uses (see fakeAuthServer).
 */
export async function startFakeApi({ oauth = false } = {}) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {ScriptedResponse[]} */
  const queue = [];
  /** @type {ReturnType<typeof fakeAuthServer> | undefined} */
  let auth;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const next = auth?.handle(req.method ?? '', url, req.headers, body) ?? queue.shift() ?? { status: 200, body: {} };
      const send = () => {
        const body = next.body === undefined ? '' : Buffer.isBuffer(next.body) || typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        res.writeHead(next.status ?? 200, { 'content-type': 'application/json', 'x-request-id': 'req_test_1', ...next.headers });
        res.end(body);
      };
      if (next.delayMs) setTimeout(send, next.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  if (oauth) auth = fakeAuthServer(origin);
  return {
    port: address.port,
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    /** The fake OAuth server's state (only with `{ oauth: true }`). */
    auth: auth?.state,
    /** @param {...ScriptedResponse} responses */
    respond(...responses) {
      queue.push(...responses);
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** A writable stand-in that collects what is written to it. */
export function sink(isTTY = false, onWrite = (text) => {}) {
  /** @type {Buffer[]} */
  const chunks = [];
  return {
    isTTY,
    /** @param {string | Uint8Array} chunk */
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      onWrite(Buffer.from(chunk).toString('utf8'));
      return true;
    },
    get buffer() {
      return Buffer.concat(chunks);
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * Runs the CLI in process.
 * @param {string[]} argv
 * `onStderr` sees each write to stderr as it happens; `loginTimeoutMs` shortens the wait for the sign-in callback.
 * @param {{ env?: Record<string, string | undefined>, stdin?: string | Buffer, tty?: boolean, manifest?: any,
 *   onStderr?: (text: string) => void, loginTimeoutMs?: number }} [options]
 */
export async function run(argv, options = {}) {
  const stdout = sink(options.tty ?? false);
  const stderr = sink(false, options.onStderr);
  const stdin = Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]);
  const env = { XDG_CONFIG_HOME: defaultConfigHome, APPDATA: defaultConfigHome, ...options.env };
  const code = await main(argv, { env, stdout, stderr, stdin, manifest: options.manifest, loginTimeoutMs: options.loginTimeoutMs });
  return { code, stdout: stdout.text, stdoutBuffer: stdout.buffer, stderr: stderr.text };
}

/** Parses the single JSON error document a failed command prints on stderr. */
export function errorOf(result) {
  const lines = result.stderr.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

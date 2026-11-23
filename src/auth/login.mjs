// socialapi login: OAuth 2.1 in the browser (loopback callback, PKCE S256), then a named API key
// created with the OAuth access token is stored and the OAuth tokens are revoked.
// socialapi login --with-api-key: stores a key read from stdin or a hidden prompt.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { text } from 'node:stream/consumers';
import { isSecureBaseUrl, send } from '../http.mjs';
import { CliError, EXIT, usageError } from '../errors.mjs';
import { parseBaseUrl, parseTimeout } from '../operation.mjs';
import { writeJson } from '../output.mjs';
import { SIGN_IN_OPERATIONS, callOperation, deleteStoredKey, findOperation, jsonOf, parseFlags } from './api.mjs';
import { readConfig, writeConfig } from './config.mjs';

/**
 * @typedef {import('../main.mjs').Context} Context
 * @typedef {import('./api.mjs').HttpOptions} HttpOptions
 * @typedef {{ authorization_endpoint: string, token_endpoint: string, registration_endpoint: string, revocation_endpoint: string }} Endpoints
 */

const USAGE = 'login [--with-api-key] [--no-browser] [--base-url <url>]';
const REQUIRED_ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'];

/** The command that opens a URL in the default browser. */
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', `"${url}"`] };
  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url) {
  const { command, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed too, so the person can open it by hand.
  }
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * Reads the authorization server metadata and checks every endpoint is on the API origin.
 * @param {string} authBase the base URL without /v1
 * @param {HttpOptions} http
 * @returns {Promise<Endpoints>}
 */
async function discover(authBase, http) {
  const origin = new URL(authBase).origin;
  const response = await send({ method: 'GET', url: new URL(`${authBase}/.well-known/oauth-authorization-server`), ...http });
  const invalid = (detail) =>
    new CliError('invalid_authorization_server', `The sign-in server at ${origin} ${detail}, so login stopped. Check the base URL, or sign in with socialapi login --with-api-key.`, EXIT.apiError);
  if (response.status >= 400) throw invalid(`answered ${response.status} for its discovery document`);
  let doc;
  try {
    doc = JSON.parse(response.body.toString('utf8'));
  } catch {}
  if (!doc || typeof doc !== 'object') throw invalid('has no valid discovery document');
  for (const field of REQUIRED_ENDPOINTS) if (typeof doc[field] !== 'string') throw invalid(`lists no ${field}`);
  for (const [field, value] of Object.entries(doc)) {
    if (!field.endsWith('_endpoint') || typeof value !== 'string') continue;
    let endpointOrigin;
    try {
      endpointOrigin = new URL(value).origin;
    } catch {
      throw invalid(`lists an invalid ${field}`);
    }
    if (endpointOrigin !== origin) throw invalid(`lists its ${field} on ${endpointOrigin}, another origin`);
  }
  return /** @type {Endpoints} */ (doc);
}

/**
 * Posts a form to an OAuth endpoint and returns its JSON answer.
 * @param {string} endpoint
 * @param {Record<string, string>} fields
 * @param {HttpOptions} http
 */
async function postForm(endpoint, fields, http) {
  const response = await send({
    method: 'POST',
    url: new URL(endpoint),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    ...http,
  });
  return jsonOf(response);
}

const page = (title, detail) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;margin:3em"><h1>${title}</h1><p>${detail}</p></body></html>`;

/**
 * Listens on 127.0.0.1 with an OS-assigned port for one request to /callback.
 * @returns {Promise<{ redirectUri: string, wait(check: (params: URLSearchParams) => string, timeoutMs: number): Promise<string>, close(): void }>}
 */
async function listenForCallback() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close,
    wait(check, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          close();
          reject(new CliError('login_timeout', `No sign-in arrived within ${Math.round(timeoutMs / 1000)} seconds. Run socialapi login again and finish signing in in the browser.`));
        }, timeoutMs);
        server.on('request', (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/callback') {
            res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' }).end('Not found');
            return;
          }
          clearTimeout(timer);
          const headers = { 'content-type': 'text/html; charset=utf-8', connection: 'close' };
          try {
            const code = check(url.searchParams);
            res.writeHead(200, headers).end(page('Signed in to SocialAPI', 'You can close this tab and return to the terminal.'), close);
            resolve(code);
          } catch (error) {
            const reason = error instanceof CliError ? error.code : 'error';
            res.writeHead(400, headers).end(page('Not signed in', `Sign-in stopped (${reason}). Return to the terminal for details.`), close);
            reject(error);
          }
        });
      });
    },
  };
}

/**
 * The browser flow. Returns the created key; the OAuth client secret and tokens stay in memory.
 * @param {Context} ctx
 * @param {{ base: string, http: HttpOptions, noBrowser: boolean }} options
 * @returns {Promise<{ apiKey: string, keyId: string, user: any }>}
 */
async function browserLogin(ctx, { base, http, noBrowser }) {
  const authBase = base.replace(/\/v1$/, '');
  const endpoints = await discover(authBase, http);
  const callback = await listenForCallback();
  let client;
  let code;
  const verifier = base64url(randomBytes(32));
  try {
    client = await jsonOf(
      await send({
        method: 'POST',
        url: new URL(endpoints.registration_endpoint),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: `SocialAPI CLI (${hostname()})`, redirect_uris: [callback.redirectUri] }),
        ...http,
      }),
    );
    if (typeof client.client_id !== 'string' || typeof client.client_secret !== 'string') {
      throw new CliError('invalid_authorization_server', 'The sign-in server registered no client_id and client_secret. Sign in with socialapi login --with-api-key instead.', EXIT.apiError);
    }
    const state = base64url(randomBytes(24));
    const authorize = new URL(endpoints.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: callback.redirectUri,
      scope: 'social:all',
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    })) {
      authorize.searchParams.set(name, value);
    }
    ctx.stderr.write(
      noBrowser
        ? `Open this URL in a browser to sign in to SocialAPI:\n${authorize.href}\n`
        : `Opening the browser to sign in to SocialAPI. If it does not open, visit this URL:\n${authorize.href}\n`,
    );
    if (!noBrowser) openBrowser(authorize.href);
    code = await callback.wait((params) => {
      if (params.get('state') !== state) {
        throw new CliError('invalid_state', 'The sign-in answer did not carry the state this login sent, so it was refused. Run socialapi login again.', EXIT.apiError);
      }
      const error = params.get('error');
      if (error) throw new CliError(error, params.get('error_description') || `Sign-in ended with ${error}. Run socialapi login again.`, EXIT.apiError);
      const received = params.get('code');
      if (!received) throw new CliError('invalid_request', 'The sign-in answer carried no authorization code. Run socialapi login again.', EXIT.apiError);
      return received;
    }, ctx.loginTimeoutMs);
  } finally {
    callback.close();
  }

  const credentials = { client_id: client.client_id, client_secret: client.client_secret };
  const tokens = await postForm(endpoints.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, code_verifier: verifier, ...credentials }, http);
  if (typeof tokens.access_token !== 'string') throw new CliError('invalid_grant', 'The sign-in server returned no access token. Run socialapi login again.', EXIT.apiError);
  try {
    const created = await callOperation(ctx.manifest, 'createApiKey', { base, token: tokens.access_token, body: { name: `SocialAPI CLI (${hostname()})` }, http });
    if (typeof created.raw_key !== 'string' || typeof created.id !== 'string') {
      throw new CliError('invalid_response', 'The API created a key but returned no raw_key and id. Run socialapi login again.', EXIT.apiError);
    }
    try {
      const user = await callOperation(ctx.manifest, 'getCurrentUser', { base, token: created.raw_key, http });
      return { apiKey: created.raw_key, keyId: created.id, user };
    } catch (error) {
      await deleteStoredKey(ctx.manifest, { base_url: base, api_key: created.raw_key, key_id: created.id, created_by_login: true }, http);
      throw error;
    }
  } finally {
    for (const [hint, token] of [['access_token', tokens.access_token], ['refresh_token', tokens.refresh_token]]) {
      if (typeof token !== 'string') continue;
      try {
        await postForm(endpoints.revocation_endpoint, { token, token_type_hint: hint, ...credentials }, http);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        ctx.stderr.write(`socialapi: the OAuth ${hint.replace('_', ' ')} could not be revoked (${error.code}); it stays valid until it expires.\n`);
      }
    }
  }
}

/**
 * Reads a pasted key: all of stdin when piped, or a hidden prompt on a terminal.
 * @param {Context} ctx
 */
async function readApiKey(ctx) {
  const stdin = /** @type {any} */ (ctx.stdin);
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return (await text(ctx.stdin)).trim();
  ctx.stderr.write('API key: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      ctx.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(usageError('No API key was entered.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

/** @type {import('../builtins/index.mjs').Builtin} */
export const login = {
  name: 'login',
  usage: USAGE,
  summary: 'Sign in in the browser and store a new API key, or store an existing key with --with-api-key.',
  async run(args, ctx) {
    const flags = parseFlags(args, { 'with-api-key': 'boolean', 'no-browser': 'boolean', 'base-url': 'value', timeout: 'value', verbose: 'boolean', pretty: 'boolean' }, USAGE);
    const http = { timeoutSeconds: parseTimeout(/** @type {string | undefined} */ (flags.timeout)), verbose: flags.verbose === true, stderr: ctx.stderr };
    const { base, url } = parseBaseUrl(flags['base-url'], ctx.env, ctx.manifest);
    if (!isSecureBaseUrl(url)) {
      throw new CliError('insecure_base_url', `Sign-in works only with an https:// base URL or localhost, and ${url.origin} is neither. Use an https:// base URL.`);
    }
    for (const id of SIGN_IN_OPERATIONS) findOperation(ctx.manifest, id);

    let result;
    if (flags['with-api-key']) {
      const apiKey = await readApiKey(ctx);
      if (!apiKey) throw usageError('No API key was given. Pipe the key on stdin, for example: socialapi login --with-api-key < key.txt');
      const user = await callOperation(ctx.manifest, 'getCurrentUser', { base, token: apiKey, http });
      result = { apiKey, keyId: null, user };
    } else {
      result = await browserLogin(ctx, { base, http, noBrowser: flags['no-browser'] === true });
    }
    await replaceStoredKey(ctx, { base_url: base, api_key: result.apiKey, key_id: result.keyId, created_by_login: !flags['with-api-key'] }, http);
    writeJson(ctx.stdout, { logged_in: true, base_url: base, user: result.user }, flags.pretty === true || Boolean(ctx.stdout.isTTY));
    return EXIT.ok;
  },
};

/**
 * Stores the new key, then deletes the key an earlier login created (best effort, reported on stderr).
 * @param {Context} ctx
 * @param {import('./config.mjs').StoredKey} entry
 * @param {HttpOptions} http
 */
async function replaceStoredKey(ctx, entry, http) {
  const previous = readConfig(ctx.env);
  writeConfig(ctx.env, entry);
  if (!previous?.created_by_login || !previous.key_id || previous.api_key === entry.api_key) return;
  const failure = await deleteStoredKey(ctx.manifest, previous, http);
  if (failure) {
    ctx.stderr.write(`socialapi: the previous API key ${previous.key_id} (on ${previous.base_url}) could not be deleted (${failure}). Delete it in the SocialAPI dashboard.\n`);
  }
}

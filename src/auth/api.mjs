// Sign-in calls the API through the manifest by operationId, never by a hard-coded path,
// and through the single request function of src/http.mjs.
import { CliError, EXIT, responseError, usageError } from '../errors.mjs';
import { send } from '../http.mjs';

/** The only operations sign-in names. */
export const SIGN_IN_OPERATIONS = ['createApiKey', 'getCurrentUser', 'revokeApiKey'];

/**
 * @typedef {{ timeoutSeconds: number, verbose: boolean, stderr: { write(chunk: string): any } }} HttpOptions
 * @typedef {import('../main.mjs').Context} Context
 */

/**
 * The generated command of an operation sign-in needs.
 * @param {Context['manifest']} manifest
 * @param {string} operationId
 */
export function findOperation(manifest, operationId) {
  const cmd = manifest.commands.find((c) => c.operationId === operationId);
  if (!cmd) throw new CliError('unsupported_api', `This API has no ${operationId} operation, which sign-in needs. Install the latest socialapi-cli, or pass the API key with --api-key or SOCIALAPI_API_KEY.`);
  return cmd;
}

/**
 * Calls an operation and returns its JSON response; an API error throws with the API's body.
 * @param {Context['manifest']} manifest
 * @param {string} operationId
 * @param {{ base: string, token: string, args?: string[], body?: any, http: HttpOptions }} request
 */
export async function callOperation(manifest, operationId, { base, token, args = [], body, http }) {
  const cmd = findOperation(manifest, operationId);
  const path = cmd.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(args[cmd.args.findIndex((a) => a.name === name)]));
  const response = await send({
    method: cmd.method,
    url: new URL(`${base}${path}`),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    token,
    ...http,
  });
  return jsonOf(response);
}

/**
 * The JSON body of a successful response.
 * @param {import('../http.mjs').ApiResponse} response
 */
export function jsonOf(response) {
  if (response.status >= 400) throw responseError(response);
  try {
    return response.body.length ? JSON.parse(response.body.toString('utf8')) : {};
  } catch {
    throw new CliError('invalid_response', `The server answered ${response.status} with a body that is not JSON. Check the base URL.`, EXIT.apiError);
  }
}

/**
 * Deletes a stored key on the API it was created for, using the key itself.
 * A key the API no longer knows (401 or 404) counts as deleted.
 * @param {Context['manifest']} manifest
 * @param {import('./config.mjs').StoredKey} stored
 * @param {HttpOptions} http
 * @returns {Promise<string | null>} null when deleted, otherwise what went wrong
 */
export async function deleteStoredKey(manifest, stored, http) {
  try {
    await callOperation(manifest, 'revokeApiKey', { base: stored.base_url.replace(/\/+$/, ''), token: stored.api_key, args: [stored.key_id ?? ''], http });
    return null;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.status === 401 || error.status === 404) return null;
    return `${error.code}: ${error.message}`;
  }
}

/**
 * Reads the flags of a sign-in command. Boolean flags take no value (or =true / =false).
 * @param {string[]} args
 * @param {Record<string, 'boolean' | 'value'>} accepted
 * @param {string} usage
 * @returns {Record<string, string | boolean>}
 */
export function parseFlags(args, accepted, usage) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument "${token}". Usage: socialapi ${usage}`);
    const eq = token.indexOf('=');
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const type = accepted[name];
    if (!type) throw usageError(`Unknown flag --${name}. Usage: socialapi ${usage}`);
    if (type === 'boolean') {
      const value = eq === -1 ? 'true' : token.slice(eq + 1);
      if (value !== 'true' && value !== 'false') throw usageError(`--${name} takes true or false, not "${value}".`);
      flags[name] = value === 'true';
    } else if (eq !== -1) flags[name] = token.slice(eq + 1);
    else if (i + 1 < args.length) flags[name] = args[++i];
    else throw usageError(`--${name} needs a value.`);
  }
  return flags;
}

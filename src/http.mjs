// The single function every request goes through: credential rule, timeout,
// 429 retry, verbose log and User-Agent.
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, EXIT } from './errors.mjs';
import { VERSION } from './version.mjs';

export const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** A credential is sent only over https, or to localhost. */
export function isSecureBaseUrl(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname));
}

/**
 * Milliseconds to wait for a Retry-After value (seconds or an HTTP date), capped at 60 seconds.
 * Without a usable value the wait is 1 second.
 * @param {string | null} value
 */
export function retryDelayMs(value, now = Date.now()) {
  let ms = 1000;
  if (value && /^\d+(\.\d+)?$/.test(value.trim())) ms = Number(value) * 1000;
  else if (value && !Number.isNaN(Date.parse(value))) ms = Date.parse(value) - now;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

/**
 * @typedef {{ status: number, headers: Headers, body: Buffer }} ApiResponse
 * @param {{ method: string, url: URL, headers?: Record<string, string>, body?: string | FormData, token?: string,
 *   timeoutSeconds?: number, verbose?: boolean, stderr: { write(chunk: string): any } }} request
 * @returns {Promise<ApiResponse>}
 */
export async function send({ method, url, headers = {}, body, token, timeoutSeconds = 60, verbose = false, stderr }) {
  if (token && !isSecureBaseUrl(url)) {
    throw new CliError(
      'insecure_base_url',
      `The API key is sent only to an https:// base URL or to localhost, and ${url.origin} is neither. Use an https:// base URL.`,
    );
  }
  const log = (line) => {
    if (verbose) stderr.write(`socialapi: ${token ? line.split(token).join('***') : line}\n`);
  };
  /** @type {Record<string, string>} */
  const requestHeaders = { 'user-agent': `socialapi-cli/${VERSION}`, accept: 'application/json, */*', ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  for (let attempt = 0; ; attempt++) {
    log(`> ${method} ${url.href}`);
    const controller = new AbortController();
    const timer = timeoutSeconds > 0 ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : undefined;
    /** @type {ApiResponse} */
    let response;
    try {
      const res = await fetch(url, { method, headers: requestHeaders, body, signal: controller.signal });
      response = { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CliError('timeout', `No response from ${url.origin} within ${timeoutSeconds} seconds. Try again, or raise --timeout.`, EXIT.unreachable);
      }
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
      throw new CliError('network_error', `Could not reach ${url.origin} (${cause}). Check the network connection and the base URL.`, EXIT.unreachable);
    } finally {
      clearTimeout(timer);
    }
    log(`< ${response.status} (request id ${response.headers.get('x-request-id') ?? 'none'})`);
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;
    const wait = retryDelayMs(response.headers.get('retry-after'));
    log(`rate limited, retrying in ${wait / 1000} seconds`);
    await sleep(wait);
  }
}

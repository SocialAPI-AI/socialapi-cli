// Shared test helpers: the spec, the fake API server and an in-process runner.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../src/main.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** @param {string} path relative to the repo root */
export function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

export const spec = readJson('openapi.json');

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

/** A fake API on 127.0.0.1 (random port) that records requests and plays scripted responses. */
export async function startFakeApi() {
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {ScriptedResponse[]} */
  const queue = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) });
      const next = queue.shift() ?? { status: 200, body: {} };
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
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
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
export function sink(isTTY = false) {
  /** @type {Buffer[]} */
  const chunks = [];
  return {
    isTTY,
    /** @param {string | Uint8Array} chunk */
    write(chunk) {
      chunks.push(Buffer.from(chunk));
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
 * @param {{ env?: Record<string, string | undefined>, stdin?: string | Buffer, tty?: boolean, manifest?: any }} [options]
 */
export async function run(argv, options = {}) {
  const stdout = sink(options.tty ?? false);
  const stderr = sink(false);
  const stdin = Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]);
  const code = await main(argv, { env: options.env ?? {}, stdout, stderr, stdin, manifest: options.manifest });
  return { code, stdout: stdout.text, stdoutBuffer: stdout.buffer, stderr: stderr.text };
}

/** Parses the single JSON error document a failed command prints on stderr. */
export function errorOf(result) {
  const lines = result.stderr.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

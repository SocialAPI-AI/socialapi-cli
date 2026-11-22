import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../scripts/generate.mjs';
import { run, startFakeApi, spec, errorOf, readJson } from './helpers.mjs';

const manifest = buildManifest(spec);
const dir = mkdtempSync(join(tmpdir(), 'socialapi-cli-test-'));

/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let api;
let env;
before(async () => {
  api = await startFakeApi();
  env = { SOCIALAPI_BASE_URL: api.baseUrl, SOCIALAPI_API_KEY: 'sapi_key_envsecret' };
});
after(() => api.close());
beforeEach(() => api.reset());

const cli = (argv, options = {}) => run(argv, { env, manifest, ...options });
const bodyOf = (req) => JSON.parse(req.body.toString());

/** Asserts the CLI error envelope with the given code and exit code, and that no request was sent. */
function assertCliError(result, code, exitCode = 2) {
  assert.equal(result.code, exitCode, result.stderr);
  const error = errorOf(result);
  assert.equal(error.error.code, code);
  assert.equal(typeof error.error.message, 'string');
  assert.ok(!result.stderr.includes('\u2014'), 'no em dash in errors');
  assert.equal(result.stdout, '');
}

// Usage errors: exit 2, CLI envelope, no request.

test('a missing positional argument exits 2 with invalid_usage and sends nothing', async () => {
  assertCliError(await cli(['reply-to-comment', '--text', 'x']), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

test('an extra positional argument exits 2', async () => {
  assertCliError(await cli(['list-accounts', 'extra']), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

test('an unknown flag exits 2 and suggests the nearest flag', async () => {
  const result = await cli(['list-accounts', '--brand-idd', 'x']);
  assertCliError(result, 'invalid_usage');
  assert.match(errorOf(result).error.message, /--brand-id/);
  assert.equal(api.requests.length, 0);
});

test('--all on a command that is not paginated is an unknown flag', async () => {
  assertCliError(await cli(['list-accounts', '--all']), 'invalid_usage');
});

test('a value outside its enum exits 2 and names the valid values', async () => {
  const cmd = manifest.commands.find((c) => c.flags.some((f) => f.in === 'query' && f.enum));
  const flag = cmd.flags.find((f) => f.in === 'query' && f.enum);
  const result = await cli([cmd.name, ...cmd.args.map(() => 'x'), `--${flag.flag}`, 'not-a-valid-value']);
  assertCliError(result, 'invalid_usage');
  assert.match(errorOf(result).error.message, new RegExp(String(flag.enum[0])));
  assert.equal(api.requests.length, 0);
});

test('a value of the wrong type exits 2', async () => {
  const cmd = manifest.commands.find((c) => c.flags.some((f) => f.in === 'query' && f.type === 'integer'));
  const flag = cmd.flags.find((f) => f.in === 'query' && f.type === 'integer');
  assertCliError(await cli([cmd.name, ...cmd.args.map(() => 'x'), `--${flag.flag}`, 'ten']), 'invalid_usage');
  assertCliError(await cli(['create-post', '--text', 'x', '--publish-now=maybe']), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

test('invalid JSON in a flag or in --data exits 2', async () => {
  assertCliError(await cli(['create-post', '--platform-data', '{nope']), 'invalid_usage');
  assertCliError(await cli(['create-post', '--data', '{nope']), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

test('a flag without its value exits 2', async () => {
  assertCliError(await cli(['list-accounts', '--brand-id']), 'invalid_usage');
});

test('a missing required field after merging --data and flags exits 2', async () => {
  const manifest = buildManifest(readJson('test/fixtures/collision.json'));
  const base = ['search-things', 't1', '--base-url', api.baseUrl];
  assertCliError(await cli([...base], { manifest }), 'invalid_usage');
  assert.equal(api.requests.length, 0);
  const result = await cli([...base, '--data', '{"limit":3}'], { manifest });
  assert.equal(result.code, 0, result.stderr);
});

test('an unknown command exits 2 and suggests the nearest names', async () => {
  const result = await cli(['list-acounts']);
  assertCliError(result, 'invalid_usage');
  assert.match(errorOf(result).error.message, /list-accounts/);
});

// --data

test('--data takes inline JSON and an individual flag overrides the same field', async () => {
  const result = await cli(['reply-to-comment', 'p1', '--data', '{"text":"from data","account_id":"a1"}', '--text', 'from flag']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(bodyOf(api.requests[0]), { text: 'from flag', account_id: 'a1' });
});

test('--data @file reads the body from a file', async () => {
  const file = join(dir, 'body.json');
  writeFileSync(file, '{"text":"from file"}');
  const result = await cli(['reply-to-comment', 'p1', '--data', `@${file}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(bodyOf(api.requests[0]), { text: 'from file' });
});

test('--data - reads the body from stdin', async () => {
  const result = await cli(['reply-to-comment', 'p1', '--data', '-'], { stdin: '{"text":"from stdin"}' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(bodyOf(api.requests[0]), { text: 'from stdin' });
});

test('--data with a file that does not exist exits 2', async () => {
  assertCliError(await cli(['reply-to-comment', 'p1', '--data', `@${join(dir, 'missing.json')}`]), 'invalid_usage');
});

// Credentials and base URL

test('a missing credential exits 2 with no_credential and sends nothing', async () => {
  assertCliError(await cli(['list-accounts'], { env: { SOCIALAPI_BASE_URL: api.baseUrl } }), 'no_credential');
  assert.equal(api.requests.length, 0);
});

test('an operation that declares no security is sent without a credential', async () => {
  const manifest = buildManifest(readJson('test/fixtures/collision.json'));
  const result = await cli(['get-public-thing'], { manifest, env: { SOCIALAPI_BASE_URL: api.baseUrl, SOCIALAPI_API_KEY: 'sapi_key_x' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].headers.authorization, undefined);
});

test('--api-key wins over SOCIALAPI_API_KEY', async () => {
  await cli(['list-accounts', '--api-key', 'sapi_key_flag']);
  assert.equal(api.requests[0].headers.authorization, 'Bearer sapi_key_flag');
});

test('--base-url wins over SOCIALAPI_BASE_URL', async () => {
  const result = await cli(['list-accounts', '--base-url', `${api.origin}/other`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].path, '/other/accounts');
});

test('a credential is never sent to an http base URL that is not localhost', async () => {
  const result = await cli(['list-accounts', '--base-url', `http://example.test:${api.port}/v1`]);
  assertCliError(result, 'insecure_base_url');
  assert.equal(api.requests.length, 0);
});

test('localhost, 127.0.0.1 and [::1] are allowed over http', async () => {
  for (const host of ['localhost', '127.0.0.1']) {
    const result = await cli(['list-accounts', '--base-url', `http://${host}:${api.port}/v1`]);
    assert.equal(result.code, 0, result.stderr);
  }
  const { isSecureBaseUrl } = await import('../src/http.mjs');
  assert.equal(isSecureBaseUrl(new URL('http://[::1]:8080/v1')), true);
  assert.equal(isSecureBaseUrl(new URL('https://api.example.test/v1')), true);
  assert.equal(isSecureBaseUrl(new URL('http://localhost.example.test/v1')), false);
});

test('the default base URL is the spec server URL', async () => {
  const { resolveBaseUrl } = await import('../src/operation.mjs');
  assert.equal(resolveBaseUrl(undefined, {}, manifest), 'https://api.social-api.ai/v1');
});

test('an invalid base URL exits 2', async () => {
  assertCliError(await cli(['list-accounts', '--base-url', 'not a url']), 'invalid_usage');
});

// Network failures

test('an unreachable port exits 3 with network_error', async () => {
  const closed = await startFakeApi();
  await closed.close();
  assertCliError(await cli(['list-accounts', '--base-url', closed.baseUrl]), 'network_error', 3);
});

test('a timeout exits 3 with timeout', async () => {
  api.respond({ delayMs: 3000, body: {} });
  const started = Date.now();
  assertCliError(await cli(['list-accounts', '--timeout', '0.2']), 'timeout', 3);
  assert.ok(Date.now() - started < 2500);
});

test('--timeout must be a non-negative number', async () => {
  assertCliError(await cli(['list-accounts', '--timeout', 'soon']), 'invalid_usage');
  assertCliError(await cli(['list-accounts', '--timeout', '-1']), 'invalid_usage');
});

// 429 retry

test('a 429 is retried after Retry-After, at most 3 times, then exits 1', async () => {
  const limited = { status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"code":"rate_limited","message":"Slow down"},"request_id":"r"}' };
  api.respond(limited, limited, limited, limited, { body: { never: true } });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 1);
  assert.equal(api.requests.length, 4);
  assert.equal(errorOf(result).error.code, 'rate_limited');
});

test('a 429 followed by a success prints the success', async () => {
  api.respond({ status: 429, headers: { 'retry-after': '0' }, body: {} }, { body: { ok: true } });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"ok":true}\n');
  assert.equal(api.requests.length, 2);
});

test('Retry-After is read as seconds or as an HTTP date, and each wait is capped at 60 seconds', async () => {
  const { retryDelayMs } = await import('../src/http.mjs');
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryDelayMs('2', now), 2000);
  assert.equal(retryDelayMs('3600', now), 60000);
  assert.equal(retryDelayMs('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  assert.equal(retryDelayMs('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
  assert.equal(retryDelayMs('Thu, 01 Jan 2026 05:00:00 GMT', now), 60000);
});

test('other errors are not retried', async () => {
  api.respond({ status: 503, body: '{"error":{"code":"x","message":"y"}}' }, { body: {} });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 1);
  assert.equal(api.requests.length, 1);
});

// Verbose

test('--verbose prints the request line, status and request id on stderr, and the API key appears nowhere', async () => {
  api.respond({ status: 200, headers: { 'x-request-id': 'req_abc' }, body: { ok: true } });
  const result = await cli(['list-accounts', '--verbose', '--api-key', 'sapi_key_topsecret']);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /GET http:\/\/127\.0\.0\.1:\d+\/v1\/accounts/);
  assert.match(result.stderr, /200/);
  assert.match(result.stderr, /req_abc/);
  assert.ok(!result.stderr.includes('sapi_key_topsecret'));
  assert.ok(!result.stdout.includes('sapi_key_topsecret'));
  assert.equal(result.stdout, '{"ok":true}\n');
});

// --all

const paginated = manifest.commands.find((c) => c.pagination && c.pagination.cursor.length === 1 && c.args.length === 0)
  ?? manifest.commands.find((c) => c.pagination);

/** A page in the shape the command's pagination describes. */
function page(items, next) {
  const { list, cursor } = paginated.pagination;
  const doc = { [list]: items, extra: 'kept' };
  if (cursor.length === 1) {
    if (next) doc.next_cursor = next;
  } else {
    doc[cursor[0]] = next ? { next_cursor: next, has_more: true } : { has_more: false };
  }
  return doc;
}

test('--all follows next_cursor and prints one document with every item and no next_cursor', async () => {
  api.respond({ body: page([1, 2], 'c2') }, { body: page([3], 'c3') }, { body: page([4], undefined) });
  const argv = [paginated.name, ...paginated.args.map(() => 'x'), '--all'];
  const result = await cli(argv);
  assert.equal(result.code, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(doc[paginated.pagination.list], [1, 2, 3, 4]);
  assert.ok(!result.stdout.includes('next_cursor'));
  assert.equal(doc.extra, 'kept');
  assert.equal(api.requests.length, 3);
  assert.equal(api.requests[0].query.get('cursor'), null);
  assert.equal(api.requests[1].query.get('cursor'), 'c2');
  assert.equal(api.requests[2].query.get('cursor'), 'c3');
});

test('--all stops at the first API error and exits 1', async () => {
  api.respond({ body: page([1], 'c2') }, { status: 500, body: '{"error":{"code":"internal","message":"x"}}' });
  const result = await cli([paginated.name, ...paginated.args.map(() => 'x'), '--all']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
});

// Multipart upload and binary download

test('upload-media with a file path sends multipart/form-data containing the file bytes', async () => {
  const file = join(dir, 'photo.jpg');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xfe]);
  writeFileSync(file, bytes);
  const result = await cli(['upload-media', '--file', file]);
  assert.equal(result.code, 0, result.stderr);
  const [req] = api.requests;
  assert.equal(req.path, '/v1/media/upload');
  assert.match(String(req.headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.ok(req.body.includes(bytes));
  assert.match(req.body.toString('latin1'), /name="file"; filename="photo.jpg"/);
});

test('a multipart file that does not exist exits 2', async () => {
  assertCliError(await cli(['upload-media', '--file', join(dir, 'nope.jpg')]), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

test('get-inbox-media writes the binary body to --output byte for byte', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
  api.respond({ headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  const out = join(dir, 'media.bin');
  const result = await cli(['get-inbox-media', 'med_1', '--output', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].path, '/v1/inbox/media/med_1');
  assert.deepEqual(readFileSync(out), bytes);
  assert.equal(result.stdout, '');
});

test('get-inbox-media writes the binary body to stdout when piped', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
  api.respond({ headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  const result = await cli(['get-inbox-media', 'med_1']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdoutBuffer, bytes);
});

test('a binary response on a terminal without --output exits 2 and sends nothing', async () => {
  assertCliError(await cli(['get-inbox-media', 'med_1'], { tty: true }), 'invalid_usage');
  assert.equal(api.requests.length, 0);
});

// Collision rule end to end

test('renamed flags still send the original field names', async () => {
  const manifest = buildManifest(readJson('test/fixtures/collision.json'));
  const result = await cli(
    ['search-things', 't1', '--query-verbose', '--limit', '5', '--header-limit', 'h', '--body-limit', 'bl', '--body-limit-2', '7', '--body-data', 'd', '--verbose'],
    { manifest },
  );
  assert.equal(result.code, 0, result.stderr);
  const [req] = api.requests;
  assert.equal(req.query.get('verbose'), 'true');
  assert.equal(req.query.get('limit'), '5');
  assert.equal(req.headers.limit, 'h');
  assert.deepEqual(bodyOf(req), { body_limit: 'bl', limit: 7, data: 'd' });
  assert.match(result.stderr, /POST/);
});

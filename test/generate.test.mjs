import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, kebabCase } from '../scripts/generate.mjs';
import { readJson, spec, operations } from './helpers.mjs';

test('kebabCase follows the documented rule for words, digits and acronyms', () => {
  assert.equal(kebabCase('listAccounts'), 'list-accounts');
  assert.equal(kebabCase('getAPIKey'), 'get-api-key');
  assert.equal(kebabCase('oauth2Token'), 'oauth2-token');
  assert.equal(kebabCase('listV2Items'), 'list-v2-items');
  assert.equal(kebabCase('account_ids'), 'account-ids');
  assert.equal(kebabCase('X-Request-ID'), 'x-request-id');
});

test('the manifest holds exactly one command per operation, named the kebab case of its operationId', () => {
  const manifest = buildManifest(spec);
  const ops = operations(spec);
  assert.equal(manifest.commands.length, ops.length);
  assert.deepEqual(
    manifest.commands.map((c) => c.name).sort(),
    ops.map((o) => kebabCase(o.operation.operationId)).sort(),
  );
  assert.deepEqual(manifest.commands.map((c) => c.operationId).sort(), ops.map((o) => o.operation.operationId).sort());
});

test('the manifest records the base URL from the spec server', () => {
  assert.equal(buildManifest(spec).baseUrl, spec.servers[0].url);
});

test('list-accounts is a GET with a query flag that needs a credential', () => {
  const cmd = buildManifest(spec).commands.find((c) => c.name === 'list-accounts');
  assert.ok(cmd);
  assert.equal(cmd.operationId, 'listAccounts');
  assert.equal(cmd.method, 'GET');
  assert.equal(cmd.path, '/accounts');
  assert.equal(cmd.tag, 'Accounts');
  assert.equal(cmd.summary, 'List connected accounts');
  assert.equal(cmd.auth, true);
  assert.equal(cmd.response, 'json');
  assert.equal(cmd.body, null);
  assert.deepEqual(cmd.args, []);
  const flag = cmd.flags.find((f) => f.flag === 'brand-id');
  assert.deepEqual(
    { name: flag.name, in: flag.in, type: flag.type, required: flag.required },
    { name: 'brand_id', in: 'query', type: 'string', required: false },
  );
});

test('path parameters become positional arguments in path order', () => {
  const cmd = buildManifest(spec).commands.find((c) => c.name === 'reply-to-comment');
  assert.deepEqual(cmd.args.map((a) => a.name), ['post_id']);
  assert.deepEqual(cmd.body, { kind: 'json', required: true });
  assert.deepEqual(cmd.flags.filter((f) => f.in === 'body').map((f) => f.flag).sort(), ['account-id', 'comment-id', 'text']);
});

test('$ref and allOf are resolved: create-post has typed body flags', () => {
  const cmd = buildManifest(spec).commands.find((c) => c.name === 'create-post');
  const mediaIds = cmd.flags.find((f) => f.flag === 'media-ids');
  assert.equal(mediaIds.type, 'array');
  assert.equal(mediaIds.items, 'string');
  const targets = cmd.flags.find((f) => f.flag === 'targets');
  assert.equal(targets.type, 'array');
  assert.equal(targets.items, 'json');
  const text = cmd.flags.find((f) => f.flag === 'text');
  assert.equal(text.type, 'string');
});

test('multipart bodies mark file fields', () => {
  const cmd = buildManifest(spec).commands.find((c) => c.name === 'upload-media');
  assert.equal(cmd.body.kind, 'multipart');
  const file = cmd.flags.find((f) => f.name === 'file');
  assert.equal(file.file, true);
  assert.equal(file.required, true);
});

test('binary responses are recorded', () => {
  const cmd = buildManifest(spec).commands.find((c) => c.name === 'get-inbox-media');
  assert.equal(cmd.response, 'binary');
});

test('pagination needs a cursor parameter, next_cursor and exactly one top-level list', () => {
  const commands = buildManifest(spec).commands;
  for (const cmd of commands) {
    const hasCursor = cmd.flags.some((f) => f.in === 'query' && f.name === 'cursor');
    if (!hasCursor) assert.equal(cmd.pagination, null, cmd.name);
  }
  const mentions = commands.find((c) => c.name === 'list-mentions');
  assert.deepEqual(mentions.pagination, { list: 'data', cursor: ['next_cursor'] });
  const posts = commands.find((c) => c.name === 'list-posts');
  assert.deepEqual(posts.pagination, { list: 'data', cursor: ['pagination', 'next_cursor'] });
  const templates = commands.find((c) => c.name === 'list-whatsapp-templates');
  assert.equal(templates.pagination, null);
});

test('collision rule: global flags, then query, then header, then body; losers get a location prefix, then a number', () => {
  const manifest = buildManifest(readJson('test/fixtures/collision.json'));
  const cmd = manifest.commands.find((c) => c.name === 'search-things');
  const byField = Object.fromEntries(cmd.flags.map((f) => [`${f.in}:${f.name}`, f.flag]));
  assert.deepEqual(byField, {
    'query:verbose': 'query-verbose',
    'query:limit': 'limit',
    'header:limit': 'header-limit',
    'body:body_limit': 'body-limit',
    'body:limit': 'body-limit-2',
    'body:data': 'body-data',
  });
});

test('an operation without security needs no credential', () => {
  const manifest = buildManifest(readJson('test/fixtures/collision.json'));
  assert.equal(manifest.commands.find((c) => c.name === 'get-public-thing').auth, false);
  assert.equal(manifest.commands.find((c) => c.name === 'search-things').auth, true);
});

test('a command name equal to a built-in name stops generation with a message naming the operation', () => {
  assert.throws(() => buildManifest(readJson('test/fixtures/reserved.json')), /operation "login".*built-in/);
});

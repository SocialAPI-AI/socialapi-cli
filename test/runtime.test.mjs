import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildManifest } from '../scripts/generate.mjs';
import { run, startFakeApi, spec, errorOf } from './helpers.mjs';

const manifest = buildManifest(spec);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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

test('list-accounts sends GET /v1/accounts with the credential and prints the response', async () => {
  api.respond({ status: 200, body: { data: [{ id: 'acc_1' }] } });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.length, 1);
  const [req] = api.requests;
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/v1/accounts');
  assert.equal(req.headers.authorization, 'Bearer sapi_key_envsecret');
  assert.equal(req.headers['user-agent'], `socialapi-cli/${version}`);
  assert.equal(result.stdout, '{"data":[{"id":"acc_1"}]}\n');
  assert.equal(result.stderr, '');
});

test('query flags are sent under their original field names', async () => {
  await cli(['list-accounts', '--brand-id', 'b1']);
  assert.equal(api.requests[0].query.get('brand_id'), 'b1');
  await cli(['list-accounts', '--brand-id=b2']);
  assert.equal(api.requests[1].query.get('brand_id'), 'b2');
});

test('reply-to-comment takes the path parameter as a positional argument and sends a JSON body', async () => {
  const result = await cli(['reply-to-comment', 'post 1/x', '--text', 'Thanks']);
  assert.equal(result.code, 0, result.stderr);
  const [req] = api.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/v1/inbox/comments/post%201%2Fx');
  assert.match(String(req.headers['content-type']), /^application\/json/);
  assert.deepEqual(JSON.parse(req.body.toString()), { text: 'Thanks' });
});

test('create-post sends typed body fields: text, arrays of scalars, booleans and JSON arrays of objects', async () => {
  const result = await cli([
    'create-post', '--text', 'Hi',
    '--targets', '[{"account_id":"a1"},{"account_id":"a2"}]',
    '--media-ids', 'm1,m2', '--media-ids', 'm3',
    '--publish-now',
    '--skip-validation=false',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()), {
    text: 'Hi',
    targets: [{ account_id: 'a1' }, { account_id: 'a2' }],
    media_ids: ['m1', 'm2', 'm3'],
    publish_now: true,
    skip_validation: false,
  });
});

test('an array flag value starting with [ is read as a JSON array', async () => {
  await cli(['create-post', '--text', 'Hi', '--media-ids', '["a,b","c"]']);
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()).media_ids, ['a,b', 'c']);
});

test('object fields take a JSON string', async () => {
  await cli(['create-post', '--text', 'Hi', '--platform-data', '{"instagram":{"x":1}}']);
  assert.deepEqual(JSON.parse(api.requests[0].body.toString()).platform_data, { instagram: { x: 1 } });
});

test('integer flags are sent as numbers in the body and as text in the query', async () => {
  const cmd = manifest.commands.find((c) => c.flags.some((f) => f.in === 'query' && f.type === 'integer'));
  const flag = cmd.flags.find((f) => f.in === 'query' && f.type === 'integer');
  const argv = [cmd.name, ...cmd.args.map(() => 'x'), `--${flag.flag}`, '25'];
  const result = await cli(argv);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].query.get(flag.name), '25');
});

test('output is pretty on a terminal, compact when piped, and pretty with --pretty', async () => {
  const body = { data: [{ id: 'acc_1' }] };
  api.respond({ body }, { body }, { body });
  assert.equal((await cli(['list-accounts'], { tty: true })).stdout, `${JSON.stringify(body, null, 2)}\n`);
  assert.equal((await cli(['list-accounts'])).stdout, `${JSON.stringify(body)}\n`);
  assert.equal((await cli(['list-accounts', '--pretty'])).stdout, `${JSON.stringify(body, null, 2)}\n`);
});

test('an empty success body prints nothing', async () => {
  api.respond({ status: 204 });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('an API error prints the API error body unchanged on stderr and exits 1', async () => {
  const raw = '{"error":{"code":"account.not_found","message":"No such account","meta":{"id":"x"}},"request_id":"req_9"}';
  api.respond({ status: 404, body: raw });
  const result = await cli(['list-accounts']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${raw}\n`);
});

test('global flags may come before the command name', async () => {
  api.respond({ body: { ok: true } });
  const result = await cli(['--api-key', 'sapi_key_before', '--pretty', 'list-accounts', '--brand-id', 'b1']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests[0].headers.authorization, 'Bearer sapi_key_before');
  assert.equal(api.requests[0].query.get('brand_id'), 'b1');
  assert.equal(result.stdout, '{\n  "ok": true\n}\n');
});

test('a flag alone with no command exits 2', async () => {
  const result = await cli(['--pretty']);
  assert.equal(result.code, 2);
  assert.equal(errorOf(result).error.code, 'invalid_usage');
});

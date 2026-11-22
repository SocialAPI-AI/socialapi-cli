// One test per operation of openapi.json: the command built from the manifest
// must send the request the spec describes (method, path, query, body).
// Nothing here names an operation or counts them: it holds for any valid spec.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../src/manifest.mjs';
import { run, startFakeApi, spec, operations } from './helpers.mjs';

const manifest = loadManifest();
const dir = mkdtempSync(join(tmpdir(), 'socialapi-cli-commands-'));
const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
const uploadFile = join(dir, 'upload.bin');
writeFileSync(uploadFile, fileBytes);

/** Follows $ref and merges allOf, read straight from the spec. */
function deref(schema) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node[key], spec);
    const { $ref, ...rest } = schema;
    return { ...deref(target), ...rest };
  }
  if (schema.allOf) {
    const { allOf, ...rest } = schema;
    const parts = [...allOf.map(deref), rest];
    return Object.assign({}, ...parts, {
      properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
      required: parts.flatMap((p) => p.required ?? []),
    });
  }
  return schema;
}

/** A sample value for a schema. */
function sample(raw, name) {
  const schema = deref(raw);
  if (schema.enum) return schema.enum[schema.enum.length - 1];
  switch (schema.type) {
    case 'string':
      return `v_${name}`;
    case 'integer':
      return 7;
    case 'number':
      return 2.5;
    case 'boolean':
      return true;
    case 'array': {
      const items = deref(schema.items);
      if (['string', 'integer', 'number', 'boolean'].includes(items.type)) {
        return items.enum ? [items.enum[0]] : [sample(items, `${name}1`), sample(items, `${name}2`)];
      }
      return [{ key: 'value' }];
    }
    default:
      return { key: 'value' };
  }
}

/** The text a flag takes for a sample value. */
function flagArgs(flag, value) {
  if (typeof value === 'boolean') return [value ? `--${flag}` : `--${flag}=false`];
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) return [`--${flag}`, value.join(',')];
  if (typeof value === 'object') return [`--${flag}`, JSON.stringify(value)];
  return [`--${flag}`, String(value)];
}

/** @type {Awaited<ReturnType<typeof startFakeApi>>} */
let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());
beforeEach(() => api.reset());

const serverPath = new URL(spec.servers[0].url).pathname.replace(/\/$/, '');

for (const { method, path, operation, pathItem } of operations(spec)) {
  test(`${operation.operationId}: ${method.toUpperCase()} ${path}`, async () => {
    const cmd = manifest.commands.find((c) => c.operationId === operation.operationId);
    assert.ok(cmd, `a command for ${operation.operationId}`);
    const flagFor = (location, name) => {
      const flag = cmd.flags.find((f) => f.in === location && f.name === name);
      assert.ok(flag, `a flag for ${location} field ${name}`);
      return flag.flag;
    };

    const params = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(deref);
    const argv = [cmd.name];
    let expectedPath = path;
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
      const param = params.find((p) => p.in === 'path' && p.name === name);
      const value = String(sample(param?.schema ?? { type: 'string' }, name));
      argv.push(value);
      expectedPath = expectedPath.replace(`{${name}}`, encodeURIComponent(value));
    }

    const expectedQuery = new URLSearchParams();
    const expectedHeaders = {};
    for (const param of params.filter((p) => p.in === 'query' || p.in === 'header')) {
      const value = sample(param.schema, param.name);
      argv.push(...flagArgs(flagFor(param.in, param.name), value));
      if (param.in === 'query') for (const item of [value].flat()) expectedQuery.append(param.name, String(item));
      else expectedHeaders[param.name.toLowerCase()] = [value].flat().join(',');
    }

    const content = deref(operation.requestBody).content ?? {};
    const jsonType = Object.keys(content).find((t) => t.includes('json'));
    const multipart = !jsonType && content['multipart/form-data'];
    const bodySchema = deref((jsonType ? content[jsonType] : multipart)?.schema);
    const expectedBody = {};
    for (const [name, raw] of Object.entries(bodySchema.properties ?? {})) {
      const field = deref(raw);
      if (multipart && field.format === 'binary') {
        argv.push(`--${flagFor('body', name)}`, uploadFile);
        continue;
      }
      expectedBody[name] = sample(raw, name);
      argv.push(...flagArgs(flagFor('body', name), expectedBody[name]));
    }

    const success = Object.entries(operation.responses ?? {}).find(([status]) => status.startsWith('2'))?.[1];
    const types = Object.keys(deref(success).content ?? {});
    if (types.length && !types.some((t) => t.includes('json'))) argv.push('--output', join(dir, `${cmd.name}.out`));

    const result = await run(argv, { manifest, env: { SOCIALAPI_BASE_URL: api.baseUrl, SOCIALAPI_API_KEY: 'sapi_key_test' } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(api.requests.length, 1);
    const [req] = api.requests;

    assert.equal(req.method, method.toUpperCase());
    assert.equal(req.path, `${serverPath}${expectedPath}`);
    assert.deepEqual([...req.query].sort(), [...expectedQuery].sort());
    for (const [name, value] of Object.entries(expectedHeaders)) assert.equal(req.headers[name], value);
    if (operation.security?.length ?? spec.security?.length) assert.equal(req.headers.authorization, 'Bearer sapi_key_test');

    if (jsonType) {
      assert.match(String(req.headers['content-type']), /^application\/json/);
      assert.deepEqual(JSON.parse(req.body.toString()), expectedBody);
    } else if (multipart) {
      assert.match(String(req.headers['content-type']), /^multipart\/form-data; boundary=/);
      const text = req.body.toString('latin1');
      for (const name of Object.keys(bodySchema.properties ?? {})) assert.ok(text.includes(`name="${name}"`), `multipart field ${name}`);
      assert.ok(req.body.includes(fileBytes), 'multipart file bytes');
    } else {
      assert.equal(req.body.length, 0);
    }
  });
}

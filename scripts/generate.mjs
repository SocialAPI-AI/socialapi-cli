// Reduces openapi.json to the command manifest generated/commands.json.
// One command per operation; the runtime in src/ interprets the manifest.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RESERVED_NAMES } from '../src/builtins/index.mjs';
import { GLOBAL_FLAG_NAMES } from '../src/flags.mjs';
import { kebabCase } from '../src/naming.mjs';

export { kebabCase };

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const LOCATIONS = ['query', 'header', 'body'];

/**
 * @typedef {'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'json'} FlagType
 * @typedef {{ flag: string, name: string, in: 'query' | 'header' | 'body', type: FlagType, items?: FlagType, required: boolean, enum?: any[], description: string, file?: boolean }} Flag
 * @typedef {{ name: string, type: FlagType, enum?: any[], description: string }} Arg
 * @typedef {{ name: string, operationId: string, tag: string, summary: string, description: string, method: string, path: string,
 *   args: Arg[], flags: Flag[], body: null | { kind: 'json' | 'multipart', required: boolean }, response: 'json' | 'binary', auth: boolean,
 *   pagination: null | { list: string, cursor: string[] } }} Command
 * @typedef {{ baseUrl: string, tags: string[], commands: Command[] }} Manifest
 */

/** Joins hard-wrapped lines of spec prose, keeping paragraphs and list items. */
function unwrap(text) {
  return (text ?? '').trim().replace(/([^\n])\n(?!\n|\s*[-*] |\s*\d+\. )\s*/g, '$1 ');
}

/**
 * @param {any} spec
 * @returns {Manifest}
 */
export function buildManifest(spec) {
  /** Follows $ref and merges allOf into one schema. */
  const resolve = (schema, seen = new Set()) => {
    if (!schema || typeof schema !== 'object') return {};
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return {};
      const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
      const { $ref, ...siblings } = schema;
      return { ...resolve(target, new Set([...seen, schema.$ref])), ...siblings };
    }
    if (Array.isArray(schema.allOf)) {
      const { allOf, ...rest } = schema;
      const merged = { properties: {}, required: [] };
      for (const part of [...allOf.map((p) => resolve(p, seen)), rest]) {
        const { properties, required, ...other } = part;
        Object.assign(merged, other);
        Object.assign(merged.properties, properties);
        merged.required.push(...(required ?? []));
      }
      if (!Object.keys(merged.properties).length) delete merged.properties;
      return merged;
    }
    return schema;
  };

  /** @returns {{ type: FlagType, items?: FlagType, enum?: any[] }} */
  const typeOf = (raw) => {
    const schema = resolve(raw);
    const scalar = ['string', 'integer', 'number', 'boolean'];
    if (scalar.includes(schema.type)) return { type: schema.type, ...(schema.enum ? { enum: schema.enum } : {}) };
    if (schema.type === 'array') {
      const items = resolve(schema.items);
      if (scalar.includes(items.type)) return { type: 'array', items: items.type, ...(items.enum ? { enum: items.enum } : {}) };
      return { type: 'array', items: 'json' };
    }
    if (schema.type === 'object' || schema.properties || schema.additionalProperties) return { type: 'object' };
    return { type: 'json' };
  };

  const description = (raw) => unwrap(raw?.description ?? resolve(raw?.schema ?? raw).description);

  /** @type {Command[]} */
  const commands = [];
  const tags = (spec.tags ?? []).map((t) => t.name);
  const usedNames = new Set();

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const operationId = op.operationId ?? `${method} ${path}`;
      let name = kebabCase(operationId);
      if (RESERVED_NAMES.includes(name)) {
        throw new Error(`The operation "${operationId}" maps to the command name "${name}", which is a built-in command. Rename the operation in the spec.`);
      }
      for (let n = 2; usedNames.has(name); n++) name = `${kebabCase(operationId)}-${n}`;
      usedNames.add(name);

      const tag = op.tags?.[0] ?? 'Other';
      if (!tags.includes(tag)) tags.push(tag);

      // Path-level parameters apply unless the operation overrides them (same name and location).
      const params = new Map();
      for (const p of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(p))) params.set(`${p.in}:${p.name}`, p);
      const pathParams = [...params.values()].filter((p) => p.in === 'path');
      const args = [...path.matchAll(/\{([^}]+)\}/g)].map(([, argName]) => {
        const p = pathParams.find((x) => x.name === argName) ?? { name: argName, schema: { type: 'string' } };
        const { type, enum: values } = typeOf(p.schema);
        return { name: argName, type, ...(values ? { enum: values } : {}), description: description(p) };
      });

      /** @type {Omit<Flag, 'flag'>[]} */
      const fields = [];
      for (const p of params.values()) {
        if (p.in !== 'query' && p.in !== 'header') continue;
        fields.push({ name: p.name, in: p.in, ...typeOf(p.schema), required: Boolean(p.required), description: description(p) });
      }

      let body = null;
      const content = resolve(op.requestBody).content ?? {};
      const contentType = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content).find((t) => t === 'multipart/form-data');
      if (contentType) {
        const kind = contentType === 'multipart/form-data' ? 'multipart' : 'json';
        body = { kind, required: Boolean(resolve(op.requestBody).required) };
        const schema = resolve(content[contentType].schema);
        const required = schema.required ?? [];
        for (const [field, raw] of Object.entries(schema.properties ?? {})) {
          const resolved = resolve(raw);
          const isFile = kind === 'multipart' && resolved.type === 'string' && resolved.format === 'binary';
          fields.push({
            name: field,
            in: 'body',
            ...(isFile ? { type: 'string' } : typeOf(raw)),
            required: required.includes(field),
            description: unwrap(resolved.description),
            ...(isFile ? { file: true } : {}),
          });
        }
      }

      // Collision rule: global flags, then query, then header, then body.
      const taken = new Set(GLOBAL_FLAG_NAMES);
      /** @type {Flag[]} */
      const flags = [];
      for (const location of LOCATIONS) {
        for (const field of fields.filter((f) => f.in === location)) {
          const base = kebabCase(field.name);
          let flag = base;
          if (taken.has(flag)) flag = `${location}-${base}`;
          for (let n = 2; taken.has(flag); n++) flag = `${location}-${base}-${n}`;
          taken.add(flag);
          flags.push({ flag, ...field });
        }
      }

      const success = Object.entries(op.responses ?? {}).find(([status]) => /^2/.test(status))?.[1];
      const successContent = resolve(success).content ?? {};
      const contentTypes = Object.keys(successContent);
      const response = contentTypes.length && !contentTypes.some((t) => t.includes('json')) ? 'binary' : 'json';

      commands.push({
        name,
        operationId,
        tag,
        summary: unwrap(op.summary),
        description: unwrap(op.description),
        method: method.toUpperCase(),
        path,
        args,
        flags,
        body,
        response,
        auth: Array.isArray(op.security ?? spec.security) && (op.security ?? spec.security).length > 0,
        pagination: response === 'json' ? pagination(flags, successContent) : null,
      });
    }
  }

  /** Paginated: a cursor query parameter, next_cursor (top level or in a top-level object) and exactly one top-level list. */
  function pagination(flags, successContent) {
    if (!flags.some((f) => f.in === 'query' && f.name === 'cursor')) return null;
    const type = Object.keys(successContent).find((t) => t.includes('json'));
    if (!type) return null;
    const properties = resolve(successContent[type].schema).properties ?? {};
    const lists = Object.entries(properties).filter(([, s]) => resolve(s).type === 'array').map(([k]) => k);
    if (lists.length !== 1) return null;
    if ('next_cursor' in properties) return { list: lists[0], cursor: ['next_cursor'] };
    for (const [key, s] of Object.entries(properties)) {
      if ('next_cursor' in (resolve(s).properties ?? {})) return { list: lists[0], cursor: [key, 'next_cursor'] };
    }
    return null;
  }

  return { baseUrl: spec.servers?.[0]?.url ?? '', tags: tags.filter((t) => commands.some((c) => c.tag === t)), commands };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  try {
    const manifest = buildManifest(spec);
    mkdirSync(new URL('../generated/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../generated/commands.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`generated/commands.json: ${manifest.commands.length} commands`);
  } catch (error) {
    console.error(`generate: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

// Runs one generated command: parses its arguments against the manifest,
// validates them, sends the request and prints the response.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { text } from 'node:stream/consumers';
import { noCredential, resolveCredential } from './credentials.mjs';
import { EXIT, usageError } from './errors.mjs';
import { GLOBAL_FLAGS } from './flags.mjs';
import { send } from './http.mjs';
import { writeJson } from './output.mjs';
import { nearest } from './suggest.mjs';

/**
 * @typedef {import('../scripts/generate.mjs').Command} Command
 * @typedef {import('../scripts/generate.mjs').Flag} Flag
 * @typedef {import('./main.mjs').Context} Context
 */

/** Base URL: --base-url, then SOCIALAPI_BASE_URL, then the spec's server URL. */
export function resolveBaseUrl(flag, env, manifest) {
  return (flag || env.SOCIALAPI_BASE_URL || manifest.baseUrl).replace(/\/+$/, '');
}

/**
 * The base URL to call, checked: --base-url, then SOCIALAPI_BASE_URL, then the spec's server URL.
 * @returns {{ base: string, url: URL }} `base` has no trailing slash
 */
export function parseBaseUrl(flag, env, manifest) {
  const base = resolveBaseUrl(flag, env, manifest);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw usageError(`The base URL "${base}" is not a valid URL. Pass a full URL such as https://api.example.com/v1.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw usageError(`The base URL "${base}" must start with https:// or http://.`);
  return { base, url };
}

/** Seconds to wait for each response, from --timeout (default 60, 0 waits forever). */
export function parseTimeout(raw) {
  if (raw === undefined) return 60;
  const seconds = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw usageError(`--timeout takes a number of seconds (0 waits forever), not "${raw}".`);
  }
  return seconds;
}

/** The global flags a command accepts (`--all` only on paginated commands). */
export function globalFlagsFor(cmd) {
  return GLOBAL_FLAGS.filter((g) => !g.paginatedOnly || cmd.pagination);
}

/**
 * Splits argv into positionals, global flag values and operation flag values.
 * @param {Command} cmd
 * @param {string[]} argv
 */
function parseArgv(cmd, argv) {
  const globals = new Map(globalFlagsFor(cmd).map((g) => [g.flag, g]));
  const flags = new Map(cmd.flags.map((f) => [f.flag, f]));
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string>} */
  const global = {};
  /** @type {Map<Flag, string[]>} */
  const values = new Map();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const def = globals.get(name) ?? flags.get(name);
    if (!def) {
      const hint = nearest(name, [...globals.keys(), ...flags.keys()]).map((n) => `--${n}`);
      throw usageError(`Unknown flag --${name} for ${cmd.name}.${hint.length ? ` Did you mean ${hint.join(', ')}?` : ''} Run socialapi ${cmd.name} --help to see its flags.`);
    }
    let value;
    if (def.type === 'boolean') {
      value = eq === -1 ? 'true' : token.slice(eq + 1);
      if (value !== 'true' && value !== 'false') throw usageError(`--${name} takes true or false, not "${value}".`);
    } else if (eq !== -1) {
      value = token.slice(eq + 1);
    } else if (i + 1 < argv.length) {
      value = argv[++i];
    } else {
      throw usageError(`--${name} needs a value.`);
    }
    if ('in' in def) values.set(def, [...(values.get(def) ?? []), value]);
    else global[name] = value;
  }
  return { positionals, global, values };
}

function parseJson(raw, what) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw usageError(`${what} is not valid JSON (${error instanceof Error ? error.message : error}).`);
  }
}

function checkEnum(value, values, what) {
  if (values && !values.map(String).includes(String(value))) {
    throw usageError(`${what} must be one of ${values.join(', ')}, not "${value}".`);
  }
}

/** Converts one raw text value to the given scalar type. */
function scalar(raw, type, what) {
  if (type === 'integer') {
    if (!/^-?\d+$/.test(raw)) throw usageError(`${what} takes an integer, not "${raw}".`);
    return Number(raw);
  }
  if (type === 'number') {
    if (raw.trim() === '' || !Number.isFinite(Number(raw))) throw usageError(`${what} takes a number, not "${raw}".`);
    return Number(raw);
  }
  if (type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw usageError(`${what} takes true or false, not "${raw}".`);
    return raw === 'true';
  }
  if (type === 'json') return parseJson(raw, what);
  return raw;
}

/**
 * Converts the raw values of a flag to its typed value.
 * @param {Flag} flag
 * @param {string[]} raws
 */
function convert(flag, raws) {
  const what = `--${flag.flag}`;
  if (flag.type === 'array') {
    const items = [];
    for (const raw of raws) {
      if (raw.trimStart().startsWith('[')) {
        const parsed = parseJson(raw, what);
        if (!Array.isArray(parsed)) throw usageError(`${what} takes a JSON array.`);
        items.push(...parsed);
      } else if (flag.items === 'json') {
        items.push(parseJson(raw, what));
      } else {
        items.push(...raw.split(',').map((part) => scalar(part, flag.items, what)));
      }
    }
    for (const item of items) checkEnum(item, flag.enum, what);
    return items;
  }
  const raw = raws[raws.length - 1];
  if (flag.type === 'object') {
    const parsed = parseJson(raw, what);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usageError(`${what} takes a JSON object.`);
    return parsed;
  }
  const value = scalar(raw, flag.type, what);
  checkEnum(value, flag.enum, what);
  return value;
}

/** Reads --data: inline JSON, @file, or - for stdin. */
async function readData(raw, stdin) {
  let source = raw;
  if (raw === '-') source = await text(stdin);
  else if (raw.startsWith('@')) {
    try {
      source = readFileSync(raw.slice(1), 'utf8');
    } catch (error) {
      throw usageError(`Could not read the --data file ${raw.slice(1)} (${error?.code ?? error}).`);
    }
  }
  return parseJson(source, '--data');
}

/**
 * Builds the multipart body; file fields hold a path to read.
 * @param {Command} cmd
 * @param {Record<string, any>} fields
 */
function formData(cmd, fields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    const flag = cmd.flags.find((f) => f.in === 'body' && f.name === name);
    if (flag?.file) {
      let bytes;
      try {
        bytes = readFileSync(String(value));
      } catch (error) {
        throw usageError(`Could not read the file ${value} for --${flag.flag} (${error?.code ?? error}).`);
      }
      form.append(name, new Blob([bytes]), basename(String(value)));
    } else if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) {
      for (const item of value) form.append(name, String(item));
    } else {
      form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return form;
}

/**
 * @param {Command} cmd
 * @param {string[]} argv the arguments after the command name
 * @param {Context} ctx
 */
export async function runOperation(cmd, argv, ctx) {
  const { positionals, global, values } = parseArgv(cmd, argv);
  const usage = `Usage: socialapi ${[cmd.name, ...cmd.args.map((a) => `<${a.name}>`)].join(' ')} [flags]`;

  if (positionals.length < cmd.args.length) {
    throw usageError(`Missing argument <${cmd.args[positionals.length].name}>. ${usage}`);
  }
  if (positionals.length > cmd.args.length) {
    throw usageError(`Unexpected argument "${positionals[cmd.args.length]}". ${usage}`);
  }
  cmd.args.forEach((arg, i) => checkEnum(positionals[i], arg.enum, `<${arg.name}>`));

  /** @type {Record<'query' | 'header' | 'body', Record<string, any>>} */
  const fields = { query: {}, header: {}, body: {} };
  for (const [flag, raws] of values) fields[flag.in][flag.name] = convert(flag, raws);

  let body;
  if (global.data !== undefined) {
    if (!cmd.body) throw usageError(`${cmd.name} takes no request body, so --data does not apply.`);
    body = await readData(global.data, ctx.stdin);
  }
  if (Object.keys(fields.body).length) {
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) {
      throw usageError('--data must be a JSON object when it is combined with body flags.');
    }
    body = { ...body, ...fields.body };
  }
  if (body === undefined && cmd.body?.required) body = {};

  for (const flag of cmd.flags.filter((f) => f.required)) {
    const present = flag.in === 'body' ? body && typeof body === 'object' && flag.name in body : flag.name in fields[flag.in];
    if (!present) throw usageError(`Missing required ${flag.in === 'body' ? 'field' : 'flag'} --${flag.flag}${global.data !== undefined && flag.in === 'body' ? ` (or "${flag.name}" in --data)` : ''}. Run socialapi ${cmd.name} --help for details.`);
  }

  const timeoutSeconds = parseTimeout(global.timeout);
  const { base, url: baseUrl } = parseBaseUrl(global['base-url'], ctx.env, ctx.manifest);

  if (cmd.response === 'binary' && global.output === undefined && ctx.stdout.isTTY) {
    throw usageError(`${cmd.name} returns binary data. Pass --output <file>, or pipe stdout to a file or another command.`);
  }

  let token;
  if (cmd.auth) {
    const credential = resolveCredential({ apiKeyFlag: global['api-key'], env: ctx.env, baseUrl: base });
    if (!credential) throw noCredential();
    token = credential.token;
  }

  const path = cmd.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(positionals[cmd.args.findIndex((a) => a.name === name)]));
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(fields.query)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, typeof item === 'object' ? JSON.stringify(item) : String(item));
  }
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of Object.entries(fields.header)) headers[name] = Array.isArray(value) ? value.join(',') : typeof value === 'object' ? JSON.stringify(value) : String(value);

  let payload;
  if (body !== undefined) {
    if (cmd.body?.kind === 'multipart') payload = formData(cmd, body);
    else {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
  }

  const request = (cursor) => {
    const q = new URLSearchParams(query);
    if (cursor !== undefined) q.set('cursor', cursor);
    const url = new URL(`${baseUrl.href.replace(/\/+$/, '')}${path}${q.size ? `?${q}` : ''}`);
    return send({ method: cmd.method, url, headers, body: payload, token, timeoutSeconds, verbose: global.verbose === 'true', stderr: ctx.stderr });
  };
  const pretty = global.pretty === 'true' || Boolean(ctx.stdout.isTTY);

  const failed = (response) => {
    const raw = response.body.toString('utf8');
    ctx.stderr.write(raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`);
    return EXIT.apiError;
  };

  if (global.all === 'true' && cmd.pagination) {
    const { list, cursor: cursorPath } = cmd.pagination;
    const items = [];
    const seen = new Set();
    let cursor;
    let last;
    for (;;) {
      const response = await request(cursor);
      if (response.status >= 400) return failed(response);
      last = response.body.length ? JSON.parse(response.body.toString('utf8')) : {};
      items.push(...(Array.isArray(last?.[list]) ? last[list] : []));
      const holder = cursorPath.length === 1 ? last : last?.[cursorPath[0]];
      const next = holder?.next_cursor;
      if (holder && typeof holder === 'object') delete holder.next_cursor;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = String(next);
    }
    last[list] = items;
    return output(Buffer.from(JSON.stringify(last)), last);
  }

  const response = await request(undefined);
  if (response.status >= 400) return failed(response);
  if (cmd.response === 'binary' || global.output !== undefined || response.body.length === 0) return output(response.body);
  const raw = response.body.toString('utf8');
  try {
    return output(response.body, JSON.parse(raw));
  } catch {
    return output(response.body);
  }

  /**
   * Writes the body to --output, or prints it: JSON formatted, anything else as is.
   * @param {Buffer} bytes
   * @param {any} [json]
   */
  function output(bytes, json) {
    if (global.output !== undefined) {
      try {
        writeFileSync(global.output, bytes);
      } catch (error) {
        throw usageError(`Could not write to ${global.output} (${error?.code ?? error}).`);
      }
    } else if (json !== undefined) {
      writeJson(ctx.stdout, json, pretty);
    } else if (bytes.length) {
      ctx.stdout.write(bytes);
    }
    return EXIT.ok;
  }
}

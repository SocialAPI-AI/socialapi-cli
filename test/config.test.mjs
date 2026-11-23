// The config store and the stored credential source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, readConfig, removeConfig, writeConfig } from '../src/auth/config.mjs';
import { resolveCredential } from '../src/credentials.mjs';
import { tempConfigHome } from './helpers.mjs';

const entry = { base_url: 'https://api.example.com/v1', api_key: 'sapi_key_stored', key_id: 'key_1', created_by_login: true };

test('the config file is socialapi/config.json under XDG_CONFIG_HOME, then ~/.config, and under APPDATA on Windows', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/x/conf' }, 'linux'), join('/x/conf', 'socialapi', 'config.json'));
  assert.equal(configPath({ HOME: '/home/ana' }, 'darwin'), join('/home/ana', '.config', 'socialapi', 'config.json'));
  assert.equal(configPath({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\ana\\AppData\\Roaming', 'socialapi', 'config.json'));
});

test('writeConfig stores one entry that readConfig returns', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  assert.equal(readConfig(env), null);
  writeConfig(env, entry);
  assert.deepEqual(readConfig(env), entry);
  assert.deepEqual(JSON.parse(readFileSync(configPath(env), 'utf8')), entry);
});

test('the config directory has mode 0700 and the file mode 0600', { skip: process.platform === 'win32' }, () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  writeConfig(env, entry);
  assert.equal(statSync(join(env.XDG_CONFIG_HOME, 'socialapi')).mode & 0o777, 0o700);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
});

test('an existing config directory with a wider mode is narrowed to 0700', { skip: process.platform === 'win32' }, () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  mkdirSync(join(env.XDG_CONFIG_HOME, 'socialapi'), { mode: 0o755 });
  writeConfig(env, entry);
  assert.equal(statSync(join(env.XDG_CONFIG_HOME, 'socialapi')).mode & 0o777, 0o700);
});

test('writeConfig replaces the file whole and leaves no temporary file behind', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  writeConfig(env, entry);
  writeConfig(env, { ...entry, api_key: 'sapi_key_second', key_id: null, created_by_login: false });
  assert.deepEqual(readConfig(env), { ...entry, api_key: 'sapi_key_second', key_id: null, created_by_login: false });
  assert.deepEqual(readdirSync(join(env.XDG_CONFIG_HOME, 'socialapi')), ['config.json']);
});

test('removeConfig deletes the file and is fine when there is none', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  writeConfig(env, entry);
  removeConfig(env);
  assert.equal(existsSync(configPath(env)), false);
  removeConfig(env);
  assert.equal(readConfig(env), null);
});

test('a config file that is not a stored entry reads as nothing stored', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  mkdirSync(join(env.XDG_CONFIG_HOME, 'socialapi'));
  writeFileSync(configPath(env), 'not json');
  assert.equal(readConfig(env), null);
  writeFileSync(configPath(env), '{"base_url":"https://api.example.com/v1"}');
  assert.equal(readConfig(env), null);
});

// resolveCredential: --api-key, then SOCIALAPI_API_KEY, then the stored key for the same base URL.

test('the stored key is the credential for the base URL it was saved for, with or without a trailing slash', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  writeConfig(env, entry);
  assert.deepEqual(resolveCredential({ env, baseUrl: 'https://api.example.com/v1' }), { token: 'sapi_key_stored', source: 'stored' });
  assert.deepEqual(resolveCredential({ env, baseUrl: 'https://api.example.com/v1/' }), { token: 'sapi_key_stored', source: 'stored' });
  writeConfig(env, { ...entry, base_url: 'https://api.example.com/v1/' });
  assert.deepEqual(resolveCredential({ env, baseUrl: 'https://api.example.com/v1' }), { token: 'sapi_key_stored', source: 'stored' });
});

test('the stored key is not used for another base URL', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome() };
  writeConfig(env, entry);
  assert.equal(resolveCredential({ env, baseUrl: 'https://other.example.com/v1' }), null);
});

test('--api-key wins over SOCIALAPI_API_KEY, which wins over the stored key', () => {
  const env = { XDG_CONFIG_HOME: tempConfigHome(), SOCIALAPI_API_KEY: 'sapi_key_env' };
  writeConfig(env, entry);
  assert.deepEqual(resolveCredential({ apiKeyFlag: 'sapi_key_flag', env, baseUrl: entry.base_url }), { token: 'sapi_key_flag', source: 'flag' });
  assert.deepEqual(resolveCredential({ env, baseUrl: entry.base_url }), { token: 'sapi_key_env', source: 'env' });
});

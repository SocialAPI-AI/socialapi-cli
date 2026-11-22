// The config store: one stored API key, in ${XDG_CONFIG_HOME:-~/.config}/socialapi/config.json
// (%APPDATA%\socialapi\config.json on Windows). The directory is 0700, the file 0600, written atomically.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * @typedef {{ base_url: string, api_key: string, key_id: string | null, created_by_login: boolean }} StoredKey
 * @typedef {Record<string, string | undefined>} Env
 */

/** @param {Env} env */
export function configPath(env, platform = process.platform) {
  if (platform === 'win32') return join(env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming'), 'socialapi', 'config.json');
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'socialapi', 'config.json');
}

/**
 * The stored key, or null when there is none (or the file does not hold one).
 * @param {Env} env
 * @returns {StoredKey | null}
 */
export function readConfig(env) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(configPath(env), 'utf8'));
  } catch {
    return null;
  }
  if (!stored || typeof stored.base_url !== 'string' || typeof stored.api_key !== 'string' || !stored.api_key) return null;
  return { base_url: stored.base_url, api_key: stored.api_key, key_id: stored.key_id ?? null, created_by_login: stored.created_by_login === true };
}

/**
 * Replaces the stored key: writes a temporary file with mode 0600, then renames it over config.json.
 * @param {Env} env
 * @param {StoredKey} entry
 */
export function writeConfig(env, entry) {
  const file = configPath(env);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** @param {Env} env */
export function removeConfig(env) {
  try {
    unlinkSync(configPath(env));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

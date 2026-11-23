// Where the credential comes from, in order: --api-key, then SOCIALAPI_API_KEY, then the key
// stored by `socialapi login` (only for the base URL it was saved for).
import { readConfig } from './auth/config.mjs';
import { CliError } from './errors.mjs';

/** A base URL without its trailing slashes, for comparing two of them. */
export const sameBaseUrl = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * @param {{ apiKeyFlag?: string, env: Record<string, string | undefined>, baseUrl: string }} options
 * @returns {{ token: string, source: 'flag' | 'env' | 'stored' } | null}
 */
export function resolveCredential({ apiKeyFlag, env, baseUrl }) {
  if (apiKeyFlag) return { token: apiKeyFlag, source: 'flag' };
  if (env.SOCIALAPI_API_KEY) return { token: env.SOCIALAPI_API_KEY, source: 'env' };
  const stored = readConfig(env);
  if (stored && sameBaseUrl(stored.base_url, baseUrl)) return { token: stored.api_key, source: 'stored' };
  return null;
}

export const noCredential = () =>
  new CliError('no_credential', 'No API key found. Run socialapi login, set the SOCIALAPI_API_KEY environment variable, or pass --api-key.');

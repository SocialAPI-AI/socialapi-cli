// Where the credential comes from, in order: --api-key, then SOCIALAPI_API_KEY.

/**
 * @param {{ apiKeyFlag?: string, env: Record<string, string | undefined>, baseUrl: string }} options
 * @returns {{ token: string, source: 'flag' | 'env' | 'stored' } | null}
 */
export function resolveCredential({ apiKeyFlag, env, baseUrl }) {
  if (apiKeyFlag) return { token: apiKeyFlag, source: 'flag' };
  if (env.SOCIALAPI_API_KEY) return { token: env.SOCIALAPI_API_KEY, source: 'env' };
  return null;
}

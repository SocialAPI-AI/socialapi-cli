// Errors raised by the CLI itself. They print as {"error":{"code","message"}} on stderr,
// or as the API's error body unchanged when they carry one.

export const EXIT = { ok: 0, apiError: 1, usage: 2, unreachable: 3 };

export class CliError extends Error {
  /**
   * @param {'invalid_usage' | 'no_credential' | 'insecure_base_url' | 'network_error' | 'timeout' | string} code
   * @param {string} message what happened and what to do
   * @param {number} [exitCode]
   */
  constructor(code, message, exitCode = EXIT.usage) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    /** @type {string | undefined} the API's error body, printed as is instead of the envelope */
    this.body = undefined;
    /** @type {number | undefined} the HTTP status of the API response this error comes from */
    this.status = undefined;
  }
}

/**
 * The error for a failed API response (exit 1): the API's error body unchanged, or an OAuth error
 * (`{"error":"access_denied","error_description":"..."}`) turned into the CLI envelope.
 * @param {{ status: number, body: Buffer }} response
 */
export function responseError(response) {
  const raw = response.body.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (parsed && typeof parsed.error === 'string') {
    const error = new CliError(parsed.error, parsed.error_description || `The server answered ${response.status} ${parsed.error}.`, EXIT.apiError);
    error.status = response.status;
    return error;
  }
  const error = new CliError(parsed?.error?.code ?? 'api_error', parsed?.error?.message ?? `The server answered ${response.status}.`, EXIT.apiError);
  error.body = raw;
  error.status = response.status;
  return error;
}

/** @param {string} message */
export const usageError = (message) => new CliError('invalid_usage', message);

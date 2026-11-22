// Errors raised by the CLI itself. They print as {"error":{"code","message"}} on stderr.

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
  }
}

/** @param {string} message */
export const usageError = (message) => new CliError('invalid_usage', message);

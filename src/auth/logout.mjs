// socialapi logout: removes the stored key, and deletes it on the API when `socialapi login` created it.
import { CliError, EXIT } from '../errors.mjs';
import { parseTimeout } from '../operation.mjs';
import { writeJson } from '../output.mjs';
import { deleteStoredKey, parseFlags } from './api.mjs';
import { readConfig, removeConfig } from './config.mjs';

const USAGE = 'logout';

/** @type {import('../builtins/index.mjs').Builtin} */
export const logout = {
  name: 'logout',
  usage: USAGE,
  summary: 'Remove the stored API key, and delete it on the API when socialapi login created it.',
  async run(args, ctx) {
    const flags = parseFlags(args, { timeout: 'value', verbose: 'boolean', pretty: 'boolean' }, USAGE);
    const http = { timeoutSeconds: parseTimeout(/** @type {string | undefined} */ (flags.timeout)), verbose: flags.verbose === true, stderr: ctx.stderr };
    const pretty = flags.pretty === true || Boolean(ctx.stdout.isTTY);
    const stored = readConfig(ctx.env);
    if (!stored) {
      removeConfig(ctx.env);
      writeJson(ctx.stdout, { logged_out: false, message: 'No API key is stored, so there is nothing to remove.' }, pretty);
      return EXIT.ok;
    }
    let failure = null;
    try {
      if (stored.created_by_login && stored.key_id) failure = await deleteStoredKey(ctx.manifest, stored, http);
    } finally {
      removeConfig(ctx.env);
    }
    if (failure) {
      throw new CliError(
        'key_not_deleted',
        `The API key was removed from this computer, but deleting it on the API failed (${failure}). Delete the key ${stored.key_id} in the SocialAPI dashboard.`,
        EXIT.apiError,
      );
    }
    writeJson(ctx.stdout, { logged_out: true, base_url: stored.base_url, key_deleted: stored.created_by_login }, pretty);
    return EXIT.ok;
  },
};

// Global flags, shared by the generator (collision rule) and the runtime.

/** @typedef {{ flag: string, type: 'string' | 'number' | 'boolean', value?: string, description: string, paginatedOnly?: boolean }} GlobalFlag */

/** @type {GlobalFlag[]} */
export const GLOBAL_FLAGS = [
  { flag: 'api-key', type: 'string', value: 'key', description: 'API key to send. Default: the SOCIALAPI_API_KEY environment variable.' },
  { flag: 'base-url', type: 'string', value: 'url', description: 'API base URL. Default: the SOCIALAPI_BASE_URL environment variable, then the URL from the API reference.' },
  { flag: 'data', type: 'string', value: 'json', description: 'Whole JSON request body: inline JSON, @file to read a file, or - to read stdin. Individual flags override its top-level fields.' },
  { flag: 'output', type: 'string', value: 'file', description: 'Write the response body to this file instead of stdout.' },
  { flag: 'pretty', type: 'boolean', description: 'Print JSON indented, even when stdout is not a terminal.' },
  { flag: 'timeout', type: 'number', value: 'seconds', description: 'Seconds to wait for each response (default 60, 0 waits forever).' },
  { flag: 'verbose', type: 'boolean', description: 'Print the request line, the status and the request id on stderr.' },
  { flag: 'help', type: 'boolean', description: 'Show help for the command.' },
  { flag: 'all', type: 'boolean', description: 'Follow next_cursor and print every page as one document.', paginatedOnly: true },
];

/** Names an operation flag can never take; `all` is reserved on every command. */
export const GLOBAL_FLAG_NAMES = GLOBAL_FLAGS.map((f) => f.flag);

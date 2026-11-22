# socialapi-cli

`socialapi` is the official command-line client for the [SocialAPI](https://social-api.ai) REST API. Every API operation is a command, generated from the API's OpenAPI spec, so the CLI always covers the whole API reference. Commands print JSON and use stable exit codes, which makes them easy to script and to hand to AI agents.

```sh
npm install -g socialapi-cli
socialapi login
socialapi list-accounts
```

## Install

```sh
npm install -g socialapi-cli
```

This installs the `socialapi` command. It needs Node.js 20 or later and has no other dependencies.

The version of `socialapi-cli` matches the API release it was generated from: API `v1.10.4` ships as `socialapi-cli@1.10.4`.

## Sign in

### In the browser

```sh
socialapi login
```

`socialapi login` opens the SocialAPI sign-in page in your browser. After you approve access, the CLI creates an API key named `SocialAPI CLI (<hostname>)` for your account and stores it on this computer. The key shows up in the dashboard with the other API keys, where you can revoke it at any time. The sign-in itself is not kept: only the key is stored.

The CLI prints the sign-in URL on stderr too. When the browser does not open (for example on a remote machine over SSH), open that URL yourself. `--no-browser` only prints it:

```sh
socialapi login --no-browser
```

The browser hands the result back to the CLI on `http://127.0.0.1:<port>/callback`, so open the URL on the same computer that runs the CLI. The CLI waits 5 minutes for it.

On success, stdout holds `{"logged_in":true,"base_url":"...","user":{...}}` (the user is the `getCurrentUser` response). The key itself is never printed.

### With an existing API key

Create an API key in the SocialAPI dashboard, then:

```sh
socialapi login --with-api-key < key.txt
echo "$SOCIALAPI_KEY" | socialapi login --with-api-key
socialapi login --with-api-key    # on a terminal: asks for the key without echoing it
```

The CLI checks the key with `getCurrentUser` and stores it only when the API accepts it. An invalid key prints the API's error and exits with code 1.

### Where the key is stored

| System | File |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/socialapi/config.json`, or `~/.config/socialapi/config.json` when `XDG_CONFIG_HOME` is not set |
| Windows | `%APPDATA%\socialapi\config.json` |

The directory is readable only by you (mode 0700) and the file too (mode 0600). It holds one key and the base URL it was created for. The stored key is sent only to that base URL: with another `--base-url` or `SOCIALAPI_BASE_URL`, the CLI acts as if no key were stored.

A new `socialapi login` replaces the stored key. When the previous key was created by `socialapi login`, the CLI then deletes it on the API. If that deletion does not go through, the login still succeeds and stderr says which key to delete in the dashboard.

### Which credential is used

The first one found wins:

1. The `--api-key <key>` flag.
2. The `SOCIALAPI_API_KEY` environment variable.
3. The key stored by `socialapi login`, for the same base URL.

```sh
export SOCIALAPI_API_KEY=sapi_key_...
socialapi list-accounts
socialapi list-accounts --api-key sapi_key_...
```

The key is sent as `Authorization: Bearer <key>`, only to an `https://` base URL or to `localhost`, `127.0.0.1` or `[::1]`. Any other base URL stops with the error `insecure_base_url` before a request is made. `socialapi login` follows the same rule.

### Check who is signed in

```sh
socialapi whoami
```

`socialapi whoami` calls `getCurrentUser` with the credential the CLI would use (flag, environment variable or stored key) and prints the response. Without a credential it exits with code 2 and the error `no_credential`.

### Sign out

```sh
socialapi logout
```

`socialapi logout` removes the stored key from this computer. When `socialapi login` created the key in the browser, it also deletes the key on the API. A key stored with `--with-api-key` stays valid on the API: revoke it in the dashboard when you no longer need it.

| Result | stdout | Exit |
| --- | --- | --- |
| Key removed | `{"logged_out":true,"base_url":"...","key_deleted":true}` (`false` for a key stored with `--with-api-key`) | 0 |
| Nothing stored | `{"logged_out":false,"message":"..."}` | 0 |
| Key removed locally, but deleting it on the API did not go through | nothing; stderr holds the error `key_not_deleted` with the key id to delete in the dashboard | 1 |

`login` and `whoami` take `--base-url`, `--timeout`, `--verbose` and `--pretty` like other commands, and `whoami` takes `--api-key` too. `logout` takes `--timeout`, `--verbose` and `--pretty`, and talks to the base URL stored with the key. `--verbose` never shows the key or the sign-in tokens.

## Base URL

The CLI calls `https://api.social-api.ai/v1` by default. To call another server, use `--base-url <url>` or the `SOCIALAPI_BASE_URL` environment variable (the flag wins).

## Commands

There is one command per API operation, named after the operation's `operationId` in kebab case: `listAccounts` is `socialapi list-accounts`, `replyToComment` is `socialapi reply-to-comment`. These are the same names as in the API reference and the MCP tools.

The kebab case rule: a hyphen goes before each capital letter that follows a lowercase letter or a digit, and before the last capital of a run of capitals that is followed by a lowercase letter, then everything is lowercased. Digits stay with the letters before them. So `getAPIKey` becomes `get-api-key` and `oauth2Token` becomes `oauth2-token`. An operation without an `operationId` is named from its method and path (`get /things/{id}` becomes `get-things-id`), and if two operations reach the same name, the later one gets a numeric suffix (`-2`).

Find commands and their usage:

```sh
socialapi --help                 # every command, grouped by API tag
socialapi commands webhook       # commands whose name, tag or summary contains "webhook"
socialapi commands post --json   # the same search as JSON
socialapi create-post --help     # usage, description, arguments and flags of one command
socialapi help create-post       # the same as create-post --help
```

Built-in commands: `login [--with-api-key] [--no-browser]`, `logout`, `whoami` (see [Sign in](#sign-in)), `commands [text] [--json]`, `completion bash|zsh|fish`, `skill`, `help [command]` and `version`. `socialapi commands` lists the built-ins too, with the tag `Built-in`.

## Arguments and flags

How an operation maps to a command:

- Path parameters are positional arguments, in the order they appear in the path: `socialapi reply-to-comment <post_id>`.
- Query parameters, header parameters and top-level body fields are flags named in kebab case: `brand_id` is `--brand-id`. The request uses the original field names.
- A flag takes `--flag value` or `--flag=value`.

How a value is read, by field type:

| Field type | Example |
| --- | --- |
| string | `--text "Hello"` |
| integer, number | `--limit 25` |
| boolean | `--publish-now` for true, `--publish-now=false` for false |
| array of strings or numbers | `--media-ids m1,m2`, or `--media-ids m1 --media-ids m2`, or a JSON array `--media-ids '["m1","m2"]'` |
| array of objects | a JSON array: `--targets '[{"account_id":"acc_1"}]'` |
| object or free-form | a JSON object: `--platform-data '{"instagram":{"content_type":"feed"}}'` |
| file (multipart upload) | a file path: `--file ./photo.jpg` |

Enum values are listed in each command's `--help`.

### The whole body with --data

`--data` takes the whole JSON request body, in one of three forms:

```sh
socialapi reply-to-comment post_123 --data '{"text":"Thanks"}'
socialapi reply-to-comment post_123 --data @reply.json
cat reply.json | socialapi reply-to-comment post_123 --data -
```

Individual flags override the top-level fields of `--data`:

```sh
socialapi create-post --data @post.json --text "A new caption"
```

Before any request, the CLI checks the arguments and exits with code 2 for a missing positional argument, an unknown flag, a value of the wrong type or outside its enum, invalid JSON, or a missing required field (after merging `--data` and flags).

### Examples

```sh
socialapi list-accounts
socialapi create-post --text "Hi" --targets '[{"account_id":"acc_1"},{"account_id":"acc_2"}]'
socialapi reply-to-comment post_123 --text "Thanks"
socialapi upload-media --file ./photo.jpg
socialapi get-inbox-media med_123 --output attachment.jpg
socialapi list-posts --all
```

## Global flags

| Flag | Meaning |
| --- | --- |
| `--api-key <key>` | API key to send. Default: `SOCIALAPI_API_KEY`, then the key stored by `socialapi login`. |
| `--base-url <url>` | API base URL. Default: `SOCIALAPI_BASE_URL`, then `https://api.social-api.ai/v1`. |
| `--data <json>` | Whole JSON request body: inline, `@file`, or `-` for stdin. |
| `--output <file>` | Write the response body to a file instead of stdout. |
| `--pretty` | Print JSON indented, even when stdout is not a terminal. |
| `--timeout <seconds>` | Seconds to wait for each response. Default 60; `0` waits forever. |
| `--verbose` | Print the request line, the status and the request id on stderr. |
| `--help` | Show help for the command. |
| `--all` | On paginated commands: fetch every page and print one document. |

## Output

On success, stdout holds only the response JSON: indented with 2 spaces on a terminal, one compact line when piped, indented with `--pretty`. An empty response prints nothing.

Binary responses (such as `socialapi get-inbox-media`) go to the file named by `--output`, or to stdout when it is piped. On a terminal without `--output`, the command asks for `--output` and exits with code 2. `--output` works with JSON responses too and writes the response body as received.

`--verbose` adds lines starting with `socialapi:` on stderr: the request line, the status with the request id, and each retry. The API key never appears in them.

## Errors and exit codes

| Exit code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The API returned an error. |
| 2 | Invalid usage, no API key, or the browser sign-in timed out. |
| 3 | The API could not be reached (network failure or timeout). |

Every error is one JSON document on stderr. When the API returns an error, stderr holds the API's error body as received:

```json
{"error":{"code":"account.not_found","message":"Account not found"},"request_id":"req_..."}
```

Errors raised by the CLI itself use the same shape, with one of these codes:

| Code | Exit | What to do |
| --- | --- | --- |
| `invalid_usage` | 2 | Fix the command as the message says; `socialapi <command> --help` shows the arguments and flags. |
| `no_credential` | 2 | Run `socialapi login`, set `SOCIALAPI_API_KEY` or pass `--api-key`. |
| `insecure_base_url` | 2 | Use an `https://` base URL (or localhost). |
| `network_error` | 3 | Check the network connection and the base URL. |
| `timeout` | 3 | Try again, or raise `--timeout`. |

Sign-in adds these codes:

| Code | Exit | What to do |
| --- | --- | --- |
| `login_timeout` | 2 | The browser sign-in did not finish within 5 minutes. Run `socialapi login` again. |
| `access_denied` and other OAuth error codes | 1 | The sign-in page did not grant access. Run `socialapi login` again and approve access. |
| `invalid_state` | 1 | The answer that came back to the CLI did not belong to this login. Run `socialapi login` again. |
| `invalid_authorization_server` | 1 | The sign-in server at the base URL did not describe its endpoints on the same origin. Check the base URL, or use `socialapi login --with-api-key`. |
| `invalid_response` | 1 | The server answered with something other than the expected JSON. Check the base URL. |
| `unsupported_api` | 2 | The API has no operation that sign-in needs. Install the latest `socialapi-cli`, or pass the key with `--api-key` or `SOCIALAPI_API_KEY`. |
| `key_not_deleted` | 1 | `socialapi logout` removed the key locally; delete the key named in the message in the dashboard. |

## Rate limits and retries

When the API answers `429`, the CLI waits for the time in the `Retry-After` header (seconds or an HTTP date, at most 60 seconds per wait, 1 second when the header is absent) and tries again, up to 3 times. If the last try is still a `429`, the API's error is printed and the exit code is 1. Other errors are returned at once.

## Pagination

A command is paginated when its operation takes a `cursor` query parameter and its response holds `next_cursor` (at the top level, or inside a top-level object such as `pagination`) and exactly one top-level list. Those commands accept `--all`: the CLI follows `next_cursor` until it is absent and prints one document shaped like a single page, whose list holds every item in order and which has no `next_cursor`. The other fields come from the last page. Without `--all`, pass `--cursor` yourself to fetch the next page.

## Flag name collisions

Inside one command, two fields can map to the same flag name, or a field can match a global flag. One fixed rule settles it, in this order of precedence: global flags, then query parameters, then header parameters, then body fields. The field that loses is renamed `--<location>-<name>` (`--query-limit`, `--header-limit`, `--body-limit`), and if that name is taken too it gets a numeric suffix (`--body-limit-2`, `--body-limit-3`). The request still uses the original field name, and `--help` shows each renamed flag with the field it sends.

## Shell completion

Completion covers command names and each command's flags.

```sh
# bash: add to ~/.bashrc
source <(socialapi completion bash)

# zsh: add to ~/.zshrc, after compinit
source <(socialapi completion zsh)

# fish: add to ~/.config/fish/config.fish
socialapi completion fish | source
```

## AI agents

`socialapi skill` prints [SKILL.md](SKILL.md), a guide for AI agents that use the CLI: how to authenticate, find commands, read the JSON output and exit codes.

## Development

```sh
npm ci
npm run generate    # openapi.json to generated/commands.json
npm run typecheck
npm test
```

`openapi.json` is updated automatically on every API release. The generator, `scripts/generate.mjs`, reduces it to the command manifest `generated/commands.json`, and the runtime in `src/` interprets that manifest: no code is written per operation. Tests run against a local fake API server.

## License

[MIT](LICENSE)

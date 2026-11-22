---
name: socialapi
description: Call the SocialAPI REST API from a shell with the socialapi CLI to list connected social accounts, create and schedule posts, read and reply to comments, DMs, reviews and mentions, manage webhooks and more. Every API operation is a command with JSON output and stable exit codes.
---

# socialapi

`socialapi` is the command-line client for the SocialAPI REST API. Each API operation is one command, named after its `operationId` in kebab case (`listAccounts` is `socialapi list-accounts`). Commands print JSON on stdout, errors as JSON on stderr, and exit with a code you can branch on.

Install it with `npm install -g socialapi-cli` (Node.js 20 or later).

## Authenticate

The first credential found wins: the `--api-key` flag, then the `SOCIALAPI_API_KEY` environment variable, then the key stored by `socialapi login`.

In a non-interactive session (CI, a sandbox, an agent without a browser), use the environment variable, or store a key the person gives you:

```sh
export SOCIALAPI_API_KEY=sapi_key_...
socialapi login --with-api-key < key.txt
```

When a person is at the computer, `socialapi login` signs in through their browser and stores a new API key. It prints the sign-in URL on stderr; with `--no-browser` it only prints it, so you can hand the URL to the person. It waits up to 5 minutes for them to approve access, then prints `{"logged_in":true,"base_url":"...","user":{...}}`.

Check which account the credential belongs to before acting:

```sh
socialapi whoami
```

Without a credential, commands exit with code 2 and the error code `no_credential`: ask the person to run `socialapi login`, or to provide an API key. The stored key is used only for the base URL it was saved for. `socialapi logout` removes it (and deletes it on the API when `socialapi login` created it). Keys never appear in the output, not even with `--verbose`.

## Discover commands

Search the commands by words from their name, API tag or summary, as JSON:

```sh
socialapi commands comment --json
socialapi commands webhook --json
```

Each result has `name`, `tag`, `summary`, `method`, `path` and `arguments`. Then read the full usage of one command:

```sh
socialapi reply-to-comment --help
```

Help shows the positional arguments (the path parameters, in order), every flag with its type, whether it is required, its allowed values and its description, and the global flags.

## Pass arguments

- Positional arguments are the path parameters: `socialapi reply-to-comment <post_id>`.
- Query parameters and top-level body fields are `--kebab-case` flags: `brand_id` is `--brand-id`.
- Booleans: `--publish-now` for true, `--publish-now=false` for false.
- Arrays of strings: `--media-ids m1,m2` or repeat the flag.
- Objects and arrays of objects: a JSON string, `--targets '[{"account_id":"acc_1"}]'`.
- Files for uploads: a path, `--file ./photo.jpg`.
- The whole JSON body: `--data '{...}'`, `--data @body.json`, or `--data -` to read stdin. Individual flags override the same top-level fields of `--data`.

## Read the output

- Success: stdout holds the response JSON only (one compact line when piped). Parse it directly.
- API error: exit code 1, and stderr holds the API's error body: `{"error":{"code":"...","message":"...","meta":{...}},"request_id":"..."}`. Read `error.code` to decide what to do, and quote `request_id` when asking for support.
- CLI error: stderr holds `{"error":{"code":"...","message":"..."}}`; the message says what happened and what to do.

| Exit code | Meaning | Next step |
| --- | --- | --- |
| 0 | Success | Use stdout. |
| 1 | The API returned an error | Read `error.code` and `error.message` on stderr. |
| 2 | Invalid usage (`invalid_usage`), no API key (`no_credential`), a base URL that is not https (`insecure_base_url`) or a browser sign-in that was not finished in time (`login_timeout`) | Fix the command; check `socialapi <command> --help`. For `no_credential`, sign in first. |
| 3 | The API could not be reached (`network_error`, `timeout`) | Retry later, or raise `--timeout`. |

The CLI already retries a `429` response up to 3 times, waiting for `Retry-After`.

## Pages

List commands that return `next_cursor` accept `--all`, which fetches every page and prints one document with all items. Without it, pass `--cursor <next_cursor>` to read the next page.

## Examples

```sh
# Connected accounts, to find the account IDs other commands take
socialapi list-accounts

# Create a post for two accounts and publish it now
socialapi create-post --text "Hi" --targets '[{"account_id":"acc_1"},{"account_id":"acc_2"}]' --publish-now

# Reply to a comment on a post
socialapi reply-to-comment post_123 --text "Thanks" --comment-id comment_456 --account-id acc_1

# Every post, across all pages
socialapi list-posts --all

# Upload a file, then download an inbox attachment
socialapi upload-media --file ./photo.jpg
socialapi get-inbox-media med_123 --output attachment.jpg
```

Use `jq` to pick fields from the output, for example `socialapi list-accounts | jq -r '.data[].id'`.

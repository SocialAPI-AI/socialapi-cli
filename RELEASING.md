# Releasing socialapi-cli

Every SocialAPI API release publishes `socialapi-cli` at the same version: API `v1.10.4` publishes `socialapi-cli@1.10.4`. The release runs in GitHub Actions with npm trusted publishing, so no npm token is stored anywhere.

## How a release happens

1. For every API release tag `vX.Y.Z`, the API's release automation pushes one commit to `main` of this repo, `chore: spec from api vX.Y.Z`, with two files at the root: `openapi.json` (the published spec for that tag) and `API_VERSION` (the tag, for example `v1.10.4`). That automation needs write access to this repo's contents.
2. The push changes `API_VERSION`, which starts the [Release workflow](.github/workflows/release.yml).
3. The workflow first checks that `API_VERSION` is one line of the form `vMAJOR.MINOR.PATCH`. It then installs the dependencies, generates the command manifest, type-checks and runs the tests on that commit.
4. It removes the `v` from `API_VERSION` and compares the version with the versions already on npm and with the GitHub Releases of this repo:

   | Situation | Decision | What happens |
   | --- | --- | --- |
   | The version is not on npm and is greater than the latest published version, or nothing was published yet | `publish` | The release goes ahead. |
   | The version is lower than the latest published version | `skip` | The run ends green with a notice. |
   | The version is already on npm and its GitHub Release `vX.Y.Z` exists | `skip` | The run ends green with a notice. |
   | The version is already on npm but its GitHub Release is missing | `release` | The GitHub Release is created (with the tag `vX.Y.Z` when that is missing too), nothing is published. |

5. On `publish`, the workflow sets the version in `package.json` for the run only (`npm version X.Y.Z --no-git-tag-version`, never committed: `package.json` in git keeps `0.0.0`) and runs `npm publish --dry-run`, which lists the files of the package.
6. When the repository variable `PUBLISH` is `true`, the workflow then publishes with `npm publish --provenance --access public` through trusted publishing, in the GitHub environment `npm`, tags the commit `vX.Y.Z` and creates a GitHub Release whose notes name the API version it follows.

Release runs on `main` happen one at a time, and a run in progress always finishes. When several API tags arrive while a release is running, only the newest waiting one is released next; as it carries the highest version, the package on npm stays on the latest API.

### Dry-run mode

`PUBLISH` set to `true` in any letter case (`true`, `True`, `TRUE`) publishes. Every other value, or no variable at all, is a dry run: the workflow stops after `npm publish --dry-run` and shows a notice that the version is ready. Nothing is published, tagged or released. This is the mode the repo starts in.

### A fix that touches only the CLI

The version always follows the API, so a fix merged to `main` ships with the next API release. A manual run publishes the current `API_VERSION` only when that version is not on npm yet, for example after a failed release or after a release that happened in dry-run mode.

### Running the release by hand

In the repo, open Actions, then Release, then Run workflow, and keep the branch `main`. With the GitHub CLI:

```sh
gh workflow run release.yml --repo SocialAPI-AI/socialapi-cli --ref main
```

A manual run goes through the same steps and the same decision as a push, on the latest commit of `main`. It runs only from `main` and needs `API_VERSION`, which is there from the first spec push of an API release.

## When a release fails

A failed run opens an issue labelled `release-failed` with the API version (or the note that `API_VERSION` is missing or malformed) and a link to the run. When such an issue is already open, the run adds a comment to it instead.

1. Open the run linked in the issue and find the job that failed.
2. Fix the cause:
   - **Test and decide**: `API_VERSION` is missing or is not `vMAJOR.MINOR.PATCH` (step "Check API_VERSION"), or the tests or the type-check failed with the new spec. Fix it through a pull request to `main`.
   - **Publish to npm**: the trusted publisher on npm does not match the workflow. Check every field against [the one-time setup](#4-add-the-trusted-publisher-on-npm): organization `SocialAPI-AI`, repository `socialapi-cli`, workflow filename `release.yml`, environment `npm`, and `npm publish` among the allowed actions. A configuration that did not publish within 2 days of its creation has expired: delete it, add it again and publish within 2 days.
   - **Tag and GitHub Release**: the package is already on npm, so only the tag and the Release are left.
3. [Run the release by hand](#running-the-release-by-hand). This is the way to finish any release: the run starts from the latest commit of `main` and decides again, so it publishes the version when it is not on npm yet, creates the missing tag and GitHub Release when the version is already on npm, and otherwise ends green.

   Re-run failed jobs on the failed run is a shortcut for two cases only: after fixing the trusted publisher on npm, and when only the Tag and GitHub Release job failed. It reuses the original commit and decision, so it does not pick up a fix merged since.
4. Close the issue once the GitHub Release for the version is there.

## One-time setup

The npm steps below come from the npm documentation on [trusted publishing](https://docs.npmjs.com/trusted-publishers), checked on 2026-11-22. Do them in order, after this repo's pull requests are merged and once `API_VERSION` is on `main` (it arrives with the first spec push from an API release).

### 1. Check your tools and account

- An npm account with two-factor authentication turned on.
- npm 11.5.1 or later and Node.js 22.14.0 or later (`npm --version`, `node --version`; update npm with `npm install -g npm@latest`).

### 2. Create the package on npm

npm adds a trusted publisher only to a package that already exists, and `socialapi-cli` is new, so the first publish is done once by hand, from a clean checkout of `main`. It publishes the placeholder version `0.0.0`; every release from the workflow has a greater version.

```sh
git clone https://github.com/SocialAPI-AI/socialapi-cli.git
cd socialapi-cli
npm ci
npm login
npm publish --access public
```

npm asks for your two-factor code. The package page is then `https://www.npmjs.com/package/socialapi-cli`.

### 3. Create the GitHub environment `npm`

The publish job runs in the environment `npm`, which allows publishing only from `main`. In the repo, open Settings, then Environments, then New environment, name it `npm` and click Configure environment. Under Deployment branches and tags, choose Selected branches and tags, add the branch rule `main` and save. With the GitHub CLI:

```sh
gh api -X PUT repos/SocialAPI-AI/socialapi-cli/environments/npm \
  -F "deployment_branch_policy[protected_branches]=false" \
  -F "deployment_branch_policy[custom_branch_policies]=true"
gh api -X POST repos/SocialAPI-AI/socialapi-cli/environments/npm/deployment-branch-policies \
  -f name=main -f type=branch
```

### 4. Add the trusted publisher on npm

On npmjs.com, open Packages, then `socialapi-cli`, then Settings, and find the Trusted Publisher section. Under "Select your publisher", choose GitHub Actions and fill in the fields exactly (they are case-sensitive):

| Field | Value |
| --- | --- |
| Organization or user | `SocialAPI-AI` |
| Repository | `socialapi-cli` |
| Workflow filename | `release.yml` (the filename only, with its extension) |
| Environment name | `npm` |
| Allowed actions | turn on `npm publish` |

Save the configuration. npm checks it on the first publish, not when it is saved.

The same configuration from the command line (npm 11.15.0 or later):

```sh
npm trust github socialapi-cli --repo SocialAPI-AI/socialapi-cli --file release.yml --env npm --allow-publish
```

The 2-day window starts now: a new trusted publisher must complete its first publish within 2 days, or it expires and has to be deleted and added again.

### 5. Turn on publishing

In the repo, open Settings, then Secrets and variables, then Actions, then the Variables tab, and add a repository variable `PUBLISH` with the value `true`. With the GitHub CLI:

```sh
gh variable set PUBLISH --body true --repo SocialAPI-AI/socialapi-cli
```

### 6. Publish within 2 days

If no API release is due within 2 days of step 4, [run the release by hand](#running-the-release-by-hand). It publishes the current `API_VERSION`, which validates the trusted publisher, then creates the tag and the GitHub Release. The package page on npm then shows the provenance of the release (it links the published version to this repo and this workflow run).

Optionally, once that first workflow release is on npm, point people from the placeholder to the real releases with `npm deprecate socialapi-cli@0.0.0 "Placeholder version, install socialapi-cli@latest"`.

### 7. Allow only trusted publishing

Once the first release from the workflow is on npm, open Settings of `socialapi-cli` on npmjs.com, then Publishing access, choose "Require two-factor authentication and disallow tokens" and click Update Package Settings. Trusted publishing keeps working, as it does not use tokens.

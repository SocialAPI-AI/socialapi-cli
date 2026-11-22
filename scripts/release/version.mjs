// Decides what the release workflow does for the version in API_VERSION.
// `node scripts/release/version.mjs --check` only checks that API_VERSION exists and is well formed.
// `node scripts/release/version.mjs` prints the decision and writes action, version and reason to GITHUB_OUTPUT:
//   publish  the version is not on npm and is greater than the latest published one (or nothing was ever published)
//   release  the version is already on npm but its GitHub Release is missing: create the Release (and the tag
//            when it is missing too) without publishing
//   skip     the version is already on npm and has its GitHub Release, or it is not greater than the latest published one
// Looking up the GitHub Release uses the GitHub CLI (`gh`, with GH_TOKEN set in Actions).
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const API_VERSION_FILE = fileURLToPath(new URL('../../API_VERSION', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name;

const RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/;
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @typedef {{ action: 'publish' | 'release' | 'skip', version: string, reason: string }} Decision
 */

/**
 * Reads the content of API_VERSION (`vMAJOR.MINOR.PATCH`, one line) and returns the version without the `v`.
 * @param {string} text
 * @returns {string}
 */
export function parseApiVersion(text) {
  if (!RELEASE_VERSION.test(text)) {
    throw new Error(`API_VERSION must be one line of the form vMAJOR.MINOR.PATCH, for example v1.10.4. It contains ${JSON.stringify(text)}.`);
  }
  return text.trim().slice(1);
}

/**
 * Reads and parses an API_VERSION file.
 * @param {string} file
 * @returns {string}
 */
export function readApiVersion(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('API_VERSION is missing. It arrives with the first spec push from an API release, then the release can run.');
  }
  return parseApiVersion(text);
}

/** @param {string} version */
const parts = (version) => version.split('.').map(Number);

/**
 * Compares two plain MAJOR.MINOR.PATCH versions numerically.
 * @param {string} a
 * @param {string} b
 */
function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The pure release decision.
 * @param {{ version: string, published: string[], tagExists: boolean, releaseExists: boolean }} input
 *   `published` lists every version on npm (empty when the package was never published).
 * @returns {Decision}
 */
export function decide({ version, published, tagExists, releaseExists }) {
  const tag = `v${version}`;
  if (published.includes(version)) {
    if (releaseExists) return { action: 'skip', version, reason: `${version} is already on npm and has its GitHub Release ${tag}, nothing to do.` };
    return tagExists
      ? { action: 'release', version, reason: `${version} is already on npm and tagged ${tag} but its GitHub Release is missing, the Release will be created without publishing.` }
      : { action: 'release', version, reason: `${version} is already on npm but the tag ${tag} and its GitHub Release are missing, they will be created without publishing.` };
  }
  const releases = published.filter((v) => PLAIN_VERSION.test(v)).sort(compare);
  const latest = releases.at(-1);
  if (!latest) {
    return { action: 'publish', version, reason: `${PACKAGE} has never been published, ${version} will be the first release.` };
  }
  if (compare(version, latest) > 0) {
    return { action: 'publish', version, reason: `${version} is greater than the latest published version ${latest}.` };
  }
  return { action: 'skip', version, reason: `${version} is not greater than the latest published version ${latest}, nothing to publish.` };
}

/**
 * Reads the result of `npm view <package> versions --json`. A 404 means the package was never published.
 * @param {{ status: number | null, stdout: string }} result
 * @returns {string[]}
 */
export function parseNpmView({ status, stdout }) {
  let data;
  try {
    data = JSON.parse(stdout || 'null');
  } catch {
    data = null;
  }
  if (status === 0 && data !== null) return Array.isArray(data) ? data : [data];
  if (data?.error?.code === 'E404') return [];
  throw new Error(`could not read the published versions of ${PACKAGE} from npm: ${data?.error?.code ?? `npm exited with ${status}`}`);
}

/**
 * Parses API_VERSION, then asks the registry (and, when the version is already on npm, the repo) to decide.
 * @param {{
 *   apiVersionText: string,
 *   lookupPublished: () => Promise<string[]>,
 *   lookupTag: (tag: string) => Promise<boolean>,
 *   lookupRelease: (tag: string) => Promise<boolean>,
 * }} input
 * @returns {Promise<Decision>}
 */
export async function resolveRelease({ apiVersionText, lookupPublished, lookupTag, lookupRelease }) {
  const version = parseApiVersion(apiVersionText);
  const published = await lookupPublished();
  if (!published.includes(version)) return decide({ version, published, tagExists: false, releaseExists: false });
  const tag = `v${version}`;
  const [tagExists, releaseExists] = await Promise.all([lookupTag(tag), lookupRelease(tag)]);
  return decide({ version, published, tagExists, releaseExists });
}

/** @returns {Promise<string[]>} */
async function npmPublishedVersions() {
  const result = spawnSync('npm', ['view', PACKAGE, 'versions', '--json'], { cwd: root, encoding: 'utf8' });
  return parseNpmView({ status: result.status, stdout: result.stdout });
}

/**
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
async function remoteTagExists(tag) {
  const result = spawnSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not list the tags of origin: ${result.stderr.trim()}`);
  return result.stdout.trim() !== '';
}

/**
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
async function githubReleaseExists(tag) {
  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName'], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr)) return false;
  throw new Error(`could not look up the GitHub Release ${tag}: ${(result.stderr || result.error?.message || '').trim()}`);
}

/** @param {Record<string, string>} values */
function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

async function main() {
  if (process.argv.includes('--check')) {
    const version = readApiVersion(API_VERSION_FILE);
    console.log(`API_VERSION is v${version}, the release version is ${version}.`);
    writeOutputs({ version });
    return;
  }
  const decision = await resolveRelease({
    apiVersionText: readFileSync(API_VERSION_FILE, 'utf8'),
    lookupPublished: npmPublishedVersions,
    lookupTag: remoteTagExists,
    lookupRelease: githubReleaseExists,
  });
  console.log(`version: ${decision.version}\naction: ${decision.action}\nreason: ${decision.reason}`);
  writeOutputs(decision);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${error.message}`);
    process.exitCode = 1;
  });
}

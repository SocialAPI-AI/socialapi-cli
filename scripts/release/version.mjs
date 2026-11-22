// Decides what the release workflow does for the version in API_VERSION.
// Run as a script, it prints the decision and writes action, version and reason to GITHUB_OUTPUT:
//   publish  the version is not on npm and is greater than the latest published one (or nothing was ever published)
//   release  the version is already on npm but its tag is missing here: create the tag and the GitHub Release only
//   skip     the version is already on npm and tagged, or it is not greater than the latest published one
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
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
 * @param {{ version: string, published: string[], tagExists: boolean }} input
 *   `published` lists every version on npm (empty when the package was never published).
 * @returns {Decision}
 */
export function decide({ version, published, tagExists }) {
  const tag = `v${version}`;
  if (published.includes(version)) {
    return tagExists
      ? { action: 'skip', version, reason: `${version} is already on npm and tagged ${tag}, nothing to do.` }
      : { action: 'release', version, reason: `${version} is already on npm but the tag ${tag} is missing, the tag and the GitHub Release will be created without publishing.` };
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
 * @param {{ apiVersionText: string, lookupPublished: () => Promise<string[]>, lookupTag: (tag: string) => Promise<boolean> }} input
 * @returns {Promise<Decision>}
 */
export async function resolveRelease({ apiVersionText, lookupPublished, lookupTag }) {
  const version = parseApiVersion(apiVersionText);
  const published = await lookupPublished();
  const tagExists = published.includes(version) ? await lookupTag(`v${version}`) : false;
  return decide({ version, published, tagExists });
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

/** @returns {string} */
function readApiVersionFile() {
  try {
    return readFileSync(new URL('../../API_VERSION', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('API_VERSION is not in the repository yet. It arrives with the first spec push from the API release, then the release can run.');
  }
}

async function main() {
  const decision = await resolveRelease({
    apiVersionText: readApiVersionFile(),
    lookupPublished: npmPublishedVersions,
    lookupTag: remoteTagExists,
  });
  console.log(`version: ${decision.version}\naction: ${decision.action}\nreason: ${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(decision).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${error.message}`);
    process.exitCode = 1;
  });
}

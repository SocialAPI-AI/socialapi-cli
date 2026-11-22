/**
 * Kebab case: a hyphen goes before each capital that follows a lowercase letter or a digit,
 * and before the last capital of a run of capitals followed by a lowercase letter
 * (`getAPIKey` gives `get-api-key`). Digits stay with the letters before them
 * (`oauth2Token` gives `oauth2-token`). Any other character becomes a hyphen.
 * @param {string} text
 */
export function kebabCase(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

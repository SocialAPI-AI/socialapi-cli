/** Levenshtein distance between two strings. */
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The nearest names to `input`: close in spelling, or containing it.
 * @param {string} input
 * @param {string[]} names
 * @param {number} [max]
 */
export function nearest(input, names, max = 5) {
  const limit = Math.max(2, Math.floor(input.length / 3));
  return names
    .map((name) => ({ name, d: distance(input, name) }))
    .filter(({ name, d }) => d <= limit || (input.length >= 3 && name.includes(input)))
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(({ name }) => name);
}

/**
 * Prints a JSON value: indented with 2 spaces when pretty, one compact line otherwise.
 * @param {{ write(chunk: string): any }} stream
 * @param {any} value
 * @param {boolean} pretty
 */
export function writeJson(stream, value, pretty) {
  stream.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

/**
 * Prints rows as two aligned columns.
 * @param {[string, string][]} rows
 * @param {string} [indent]
 */
export function columns(rows, indent = '  ') {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => (right ? `${indent}${left.padEnd(width)}  ${right}` : `${indent}${left}`)).join('\n');
}

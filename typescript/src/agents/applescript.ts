/**
 * Escape a value for embedding inside an AppleScript string literal.
 *
 * This is deliberately *not* shell escaping. Scripts are handed to `osascript`
 * as a single argument vector element, so the shell is not involved; what
 * remains is the AppleScript literal itself, where a backslash, a double
 * quote, or a raw newline would otherwise terminate or corrupt the string.
 */
export function appleScriptLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

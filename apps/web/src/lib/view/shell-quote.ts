/** One literal POSIX shell word. No substitutions or secret-bearing arguments. */
export function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('A shell word cannot contain NUL.');
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

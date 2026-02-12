export function renderMarkdown(text: string): string {
  let result = text;
  // Bold: **text** → \x1b[1mtext\x1b[22m
  result = result.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m');
  // Inline code: `code` → \x1b[2mcode\x1b[22m
  result = result.replace(/`([^`]+)`/g, '\x1b[2m$1\x1b[22m');
  // Headers: # text → \x1b[1m\x1b[97mtext\x1b[0m
  result = result.replace(/^(#{1,3})\s+(.+)$/gm, '\x1b[1m\x1b[97m$2\x1b[0m');
  return result;
}

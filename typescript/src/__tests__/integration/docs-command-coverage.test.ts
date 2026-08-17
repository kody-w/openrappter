import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '../..');
const tsRoot = path.resolve(srcRoot, '..');
const repoRoot = path.resolve(tsRoot, '..');

/**
 * The published documentation, checked against the CLI that actually ships.
 *
 * The docs are a client of the CLI in exactly the way the Bar and the dashboard
 * are clients of the gateway, and they had the same defect: they documented a
 * surface nobody had compared against the real one. `docs.html` published a
 * command reference table in which seven of thirteen rows named commands the
 * CLI does not register — `status`, `gateway start`, `gateway stop`,
 * `skills remove`, `skills verify`, `memory recall`, `memory clear`.
 *
 * None of them fail loudly. The root command takes a `[message]` positional, so
 * Commander reads an unregistered command as a chat prompt and sends the word
 * to the model — the same trap PR #177 found in `install.ps1`, where
 * `node <entry> gateway` answered a question about network gateways and exited
 * 0. Following the documentation therefore does not report an error; it quietly
 * does something else. `openrappter memory clear` was documented as "Delete all
 * memory entries" and deletes nothing, which is the worst version of this: a
 * privacy action a reader can reasonably believe they performed.
 *
 * Text assertions cannot catch any of it, because every one of those strings is
 * perfectly well-formed. Only a comparison against the real registered surface
 * can, so this test reads the docs, extracts the commands they tell a reader to
 * run, and resolves each one against the CLI's own `--help`.
 */

/** Documentation that instructs a reader to run something. */
function docFiles(): string[] {
  const docsDir = path.join(repoRoot, 'docs');
  const html = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(docsDir, f));
  return [...html, path.join(repoRoot, 'README.md')].filter((f) => fs.existsSync(f));
}

/**
 * Split a command line into tokens the way a shell would.
 *
 * Quoting is what separates a command from a prompt. `openrappter "remember I
 * prefer dark mode"` is the documented way to send a message, and naive
 * whitespace splitting reads `"remember` as a subcommand the CLI fails to
 * register. A quoted token is always a value, never a command, so the quoting
 * is recorded rather than stripped and forgotten.
 */
function tokenize(line: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = [];
  let current = '';
  let quote: string | null = null;
  let quoted = false;
  let started = false;

  const flush = () => {
    if (started) tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
    started = false;
  };

  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; started = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    current += ch;
    started = true;
  }
  flush();
  return tokens;
}

/**
 * Commands as a reader encounters them: inside a code block, not in prose.
 *
 * Prose says things like "how openrappter works under the hood", where `works`
 * is a verb and not a subcommand. Restricting extraction to `<pre>`, `<code>`
 * and fenced blocks is what separates an instruction from a sentence.
 */
function documentedInvocations(file: string): { argv: { value: string; quoted: boolean }[]; line: string }[] {
  const source = fs.readFileSync(file, 'utf8');
  const isHtml = file.endsWith('.html');
  const blocks = [...source.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>|<code[^>]*>([\s\S]*?)<\/code>|```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '');

  const found: { argv: { value: string; quoted: boolean }[]; line: string }[] = [];
  for (const block of blocks) {
    // Markup is stripped only where there is markup. In Markdown a placeholder
    // like `--trace <trace-id>` is literal text, and treating it as a tag
    // deletes the argument and makes the next token look like a stray value.
    const text = isHtml
      ? block
          .replace(/<[^>]*>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
      : block;

    for (const rawLine of text.split('\n')) {
      // Comment lines are sample output, not instructions.
      const line = rawLine.replace(/^\s*[$>]\s*/, '').trim();
      if (!line || line.startsWith('#')) continue;
      // `openrappter: Shipped v1.9.1` is transcript output, not a command line.
      if (!/^openrappter(\s|$)/.test(line)) continue;

      const argv = tokenize(line.replace(/\s+#.*$/, '')).slice(1);
      found.push({ argv, line });
    }
  }
  return found;
}

interface Help {
  usage: string;
  subcommands: Set<string>;
  options: Set<string>;
  /** Options declared as taking a value, which therefore consume the next token. */
  optionsWithValue: Set<string>;
  /** Commander prints `[command]` only when subcommands are the expected next token. */
  expectsSubcommand: boolean;
  /** Whether the usage line declares any positional argument at all. */
  acceptsPositional: boolean;
}

const helpCache = new Map<string, Help | null>();

/**
 * The help for a command path, as the CLI itself reports it.
 *
 * Run through `tsx` against `src/index.ts` rather than `dist/`, so the contract
 * is measured against current source and never against a stale build — the same
 * choice PR #177 made, and for the same reason.
 */
async function readHelp(commandPath: string[]): Promise<Help | null> {
  const key = commandPath.join(' ');
  if (helpCache.has(key)) return helpCache.get(key) ?? null;

  const tsx = path.join(tsRoot, 'node_modules', '.bin', 'tsx');
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(tsx, [path.join(srcRoot, 'index.ts'), ...commandPath, '--help'], {
      cwd: tsRoot,
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: '1' },
    }));
  } catch {
    helpCache.set(key, null);
    return null;
  }

  const usage = stdout.split('\n')[0]?.trim() ?? '';

  // An unregistered command is not an error: Commander falls back to root help.
  // The usage line is what distinguishes "this command exists" from "this token
  // was swallowed as a chat message".
  const expectedUsage = `Usage: openrappter${key ? ` ${key}` : ''}`;
  if (!usage.startsWith(expectedUsage)) {
    helpCache.set(key, null);
    return null;
  }

  const subcommands = new Set<string>();
  const options = new Set<string>();
  const optionsWithValue = new Set<string>();
  let section: 'commands' | 'options' | null = null;
  for (const rawLine of stdout.split('\n')) {
    if (/^Commands:/.test(rawLine)) { section = 'commands'; continue; }
    if (/^Options:/.test(rawLine)) { section = 'options'; continue; }
    if (/^[A-Za-z].*:\s*$/.test(rawLine)) { section = null; continue; }
    if (!section) continue;

    // Entry lines are indented exactly two spaces; wrapped descriptions more.
    const entry = /^ {2}(\S.*)$/.exec(rawLine);
    if (!entry) continue;

    if (section === 'commands') {
      const name = /^([a-z][\w-]*)/.exec(entry[1]);
      if (name) subcommands.add(name[1]);
    } else {
      // `-p, --port <port>` — the flag list ends where the value placeholder or
      // the description begins, and a placeholder means the flag eats a token.
      const flagList = entry[1].split(/\s{2,}/)[0];
      const takesValue = /[<[][^>\]]+[>\]]/.test(flagList);
      for (const flag of flagList.matchAll(/(--[\w-]+|-[A-Za-z])(?=[\s,]|$)/g)) {
        options.add(flag[1]);
        if (takesValue) optionsWithValue.add(flag[1]);
      }
    }
  }

  // What the usage line says may follow the command name. `gateway [options]`
  // declares no positional and no subcommands, so a documented
  // `openrappter gateway start` is passing a token the command cannot take.
  const usageTail = usage.slice(expectedUsage.length).trim();
  const tailTokens = usageTail.split(/\s+/).filter(Boolean);
  const acceptsPositional = tailTokens.some((t) => t !== '[options]' && t !== '[command]');

  const help: Help = {
    usage,
    subcommands,
    options,
    optionsWithValue,
    expectsSubcommand: /\[command\]/.test(usage),
    acceptsPositional,
  };
  helpCache.set(key, help);
  return help;
}

interface Problem {
  file: string;
  line: string;
  detail: string;
}

/**
 * Walk a documented argv against the real CLI.
 *
 * The one subtlety is telling a subcommand apart from an argument: in
 * `openrappter hatch ada`, `ada` is a name, while in `openrappter skills verify`
 * the reader plainly means a subcommand. Commander already encodes the
 * difference in its usage line — `hatch [options] <name>` takes a positional,
 * `skills [options] [command]` does not — so the distinction is read off the
 * CLI rather than maintained as a list here.
 */
async function checkInvocation(
  argv: { value: string; quoted: boolean }[],
  file: string,
  line: string,
  rootHelp: Help,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const commandPath: string[] = [];
  const flags: string[] = [];
  let skipNext = false;

  for (const { value: token, quoted } of argv) {
    if (skipNext) { skipNext = false; continue; }

    if (!quoted && token.startsWith('-')) {
      const flag = token.split('=')[0];
      flags.push(flag);
      // `--exec Pokemon "stop"` — the agent name belongs to the flag, and is
      // not a command the CLI is expected to register.
      const owner = commandPath.length === 0 ? rootHelp : await readHelp(commandPath);
      if (!token.includes('=') && (owner?.optionsWithValue.has(flag) || rootHelp.optionsWithValue.has(flag))) {
        skipNext = true;
      }
      continue;
    }

    // A quoted token is a message or an argument, never a command name.
    if (quoted) break;

    const parentHelp = commandPath.length === 0 ? rootHelp : await readHelp(commandPath);
    // A parent we could not resolve is reported on its own; stop walking.
    if (!parentHelp) break;

    if (!parentHelp.expectsSubcommand) {
      if (parentHelp.acceptsPositional) break; // a value the command does take

      const where = commandPath.length ? `openrappter ${commandPath.join(' ')}` : 'openrappter';
      problems.push({
        file,
        line,
        detail: `\`${where}\` takes no argument, so "${token}" is silently ignored. ${parentHelp.usage}`,
      });
      return problems;
    }

    if (!parentHelp.subcommands.has(token)) {
      const where = commandPath.length ? `openrappter ${commandPath.join(' ')}` : 'openrappter';
      problems.push({
        file,
        line,
        detail:
          `"${token}" is not a command of \`${where}\`. ` +
          `Registered: ${[...parentHelp.subcommands].sort().join(', ') || '(none)'}`,
      });
      return problems;
    }
    commandPath.push(token);
  }

  const help = commandPath.length === 0 ? rootHelp : await readHelp(commandPath);
  if (!help) {
    problems.push({ file, line, detail: `\`openrappter ${commandPath.join(' ')}\` does not resolve to a registered command` });
    return problems;
  }

  for (const flag of flags) {
    if (help.options.has(flag)) continue;
    if (rootHelp.options.has(flag)) continue; // global flags are printed on root only
    problems.push({
      file,
      line,
      detail: `"${flag}" is not an option of \`openrappter ${commandPath.join(' ')}\`.`.trim(),
    });
  }

  return problems;
}

describe('documentation only tells readers to run commands that exist', () => {
  let rootHelp: Help;

  beforeAll(async () => {
    const help = await readHelp([]);
    expect(help, 'the CLI should report its own root help').not.toBeNull();
    rootHelp = help!;
  }, 180_000);

  it('reads a non-trivial command surface from the CLI', () => {
    // Anti-vacuity: if the help parser broke, every documented command would
    // "pass" for want of anything to compare against.
    expect(rootHelp.subcommands.size).toBeGreaterThan(10);
    expect(rootHelp.options.size).toBeGreaterThan(3);
  });

  it('finds documented commands to check in more than one file', () => {
    // Anti-vacuity, per file rather than in total: one extractor breaking
    // otherwise hides behind the volume the others still produce.
    const files = docFiles();
    expect(files.length).toBeGreaterThan(5);

    const withCommands = files.filter((f) => documentedInvocations(f).length > 0);
    expect(withCommands.length, 'several docs should contain runnable commands').toBeGreaterThan(3);

    const total = files.reduce((n, f) => n + documentedInvocations(f).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it('documents no command the CLI does not register', async () => {
    const problems: Problem[] = [];

    for (const file of docFiles()) {
      for (const { argv, line } of documentedInvocations(file)) {
        problems.push(...(await checkInvocation(argv, path.relative(repoRoot, file), line, rootHelp)));
      }
    }

    const report = problems
      .map((p) => `  ${p.file}\n    $ ${p.line}\n    ${p.detail}`)
      .join('\n\n');

    expect(
      problems,
      problems.length
        ? `Documentation promises commands the CLI does not register.\n` +
          `A reader who follows these gets no error: the root command takes a\n` +
          `[message] positional, so Commander sends the word to the model.\n\n${report}\n`
        : '',
    ).toEqual([]);
  }, 300_000);
});

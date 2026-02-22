/**
 * Hook Loader
 *
 * Discovers and parses HOOK.md files from ~/.openrappter/hooks/.
 *
 * Each HOOK.md has:
 *   - Optional YAML frontmatter (id, name, phase, priority, timeout)
 *   - Markdown prose
 *   - One or more fenced code blocks (```typescript or ```javascript)
 *     containing the handler body
 *
 * The first code block is used as the handler. It must export a default
 * async function OR contain statements that form the handler body.
 * For simplicity the loader wraps the code in an async function if no
 * `export default` is detected.
 *
 * Example HOOK.md:
 * ---
 * id: my-boot-hook
 * name: My Boot Hook
 * phase: boot
 * priority: 50
 * timeout: 5000
 * ---
 *
 * ## My Boot Hook
 * Runs on application startup.
 *
 * ```typescript
 * console.log('Starting up at', context.timestamp);
 * ```
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { HookDefinition, HookPhase } from './types.js';

/** All valid hook phases — used to validate frontmatter. */
const VALID_PHASES: HookPhase[] = [
  'boot',
  'shutdown',
  'message.incoming',
  'message.outgoing',
  'agent.before',
  'agent.after',
  'channel.connect',
  'channel.disconnect',
  'cron.tick',
  'error',
];

/** Regex that matches YAML frontmatter delimiters. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Regex that extracts the first typescript/javascript code block. */
const CODE_BLOCK_RE = /```(?:typescript|javascript|ts|js)\r?\n([\s\S]*?)```/;

/**
 * Minimal YAML key-value parser — no external dependencies.
 * Supports string and number scalars only (sufficient for frontmatter).
 */
function parseSimpleYaml(text: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) {
      const [, key, raw] = m;
      const trimmed = raw.trim();
      const num = Number(trimmed);
      result[key] = isNaN(num) ? trimmed : num;
    }
  }
  return result;
}

/**
 * Parse a single HOOK.md file into a HookDefinition.
 * Returns null if the file is malformed or specifies an unknown phase.
 */
function parseHookFile(filePath: string, content: string): HookDefinition | null {
  let remaining = content;
  let frontmatter: Record<string, string | number> = {};

  const fmMatch = content.match(FRONTMATTER_RE);
  if (fmMatch) {
    frontmatter = parseSimpleYaml(fmMatch[1]);
    remaining = content.slice(fmMatch[0].length);
  }

  const codeMatch = remaining.match(CODE_BLOCK_RE);
  if (!codeMatch) return null;

  const code = codeMatch[1].trim();
  const phase = (frontmatter.phase ?? '') as string;

  if (!VALID_PHASES.includes(phase as HookPhase)) {
    console.warn(`[hooks/loader] Unknown phase "${phase}" in ${filePath} — skipping`);
    return null;
  }

  const baseName = path.basename(filePath, '.md').toLowerCase();
  const id = typeof frontmatter.id === 'string' ? frontmatter.id : baseName;
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : id;
  const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;
  const timeout =
    typeof frontmatter.timeout === 'number' ? frontmatter.timeout : undefined;

  return {
    id,
    name,
    phase: phase as HookPhase,
    priority,
    timeout,
    code,
    filePath,
  };
}

/**
 * Compile a HookDefinition's code string into an async handler function.
 *
 * The code is executed with `context` bound as a local variable. If the
 * code ends with an export-default arrow/function, that export is used
 * directly; otherwise the code is treated as the handler body.
 *
 * NOTE: This uses `new Function` / dynamic evaluation. Only load hooks
 * from trusted local directories (e.g. ~/.openrappter/hooks/).
 */
function compileHandler(
  def: HookDefinition
): ((context: import('./types.js').HookContext) => Promise<import('./types.js').HookResult | void>) {
  let code = def.code;

  // If the code exports a default function, strip that and use the body
  const exportDefaultRe = /^export\s+default\s+/m;
  code = code.replace(exportDefaultRe, '');

  // Wrap in an async function if not already a function expression
  const wrappedCode = `
    return (async (context) => {
      ${code}
    })(context);
  `;

  return (context) => {
    try {
      const fn = new Function('context', wrappedCode);
      return fn(context) as Promise<import('./types.js').HookResult | void>;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return Promise.reject(error);
    }
  };
}

export class HookLoader {
  private hooksDir: string;

  constructor(hooksDir?: string) {
    this.hooksDir = hooksDir ?? path.join(os.homedir(), '.openrappter', 'hooks');
  }

  /**
   * Scan the hooks directory and parse all HOOK.md files found.
   *
   * Non-markdown files and malformed hook files are silently skipped.
   * Returns an array of fully-parsed HookDefinitions.
   */
  async scanDirectory(): Promise<HookDefinition[]> {
    if (!fs.existsSync(this.hooksDir)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.hooksDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const definitions: HookDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isFile() && !entry.isDirectory()) continue;

      if (entry.isFile() && entry.name.endsWith('.md')) {
        const filePath = path.join(this.hooksDir, entry.name);
        const def = await this.loadFile(filePath);
        if (def) definitions.push(def);
        continue;
      }

      // Also scan one level of sub-directories
      if (entry.isDirectory()) {
        const subDir = path.join(this.hooksDir, entry.name);
        let subEntries: fs.Dirent[];
        try {
          subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.md')) {
            const filePath = path.join(subDir, sub.name);
            const def = await this.loadFile(filePath);
            if (def) definitions.push(def);
          }
        }
      }
    }

    return definitions;
  }

  /**
   * Parse a single HOOK.md file.
   * Returns null if the file cannot be read or is invalid.
   */
  async loadFile(filePath: string): Promise<HookDefinition | null> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
    return parseHookFile(filePath, content);
  }

  /**
   * Load and compile all hooks from the hooks directory, registering them
   * into the provided registry.
   *
   * @returns The number of hooks successfully loaded.
   */
  async loadIntoRegistry(
    registry: import('./registry.js').HookRegistry
  ): Promise<number> {
    const definitions = await this.scanDirectory();
    let loaded = 0;

    for (const def of definitions) {
      try {
        const handler = compileHandler(def);
        registry.register(def.phase, handler, def.priority, {
          id: def.id,
          timeout: def.timeout,
          source: def.filePath,
        });
        loaded++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[hooks/loader] Failed to compile ${def.filePath}: ${msg}`);
      }
    }

    return loaded;
  }

  /**
   * Compile a HookDefinition into an executable handler function.
   * Exposed for testing and programmatic use.
   */
  compile(
    def: HookDefinition
  ): (context: import('./types.js').HookContext) => Promise<import('./types.js').HookResult | void> {
    return compileHandler(def);
  }
}

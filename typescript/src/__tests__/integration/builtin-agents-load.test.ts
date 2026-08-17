import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { BasicAgent } from '../../agents/BasicAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentsSrcDir = path.resolve(__dirname, '../../agents');

/**
 * Every built-in agent file must survive discovery.
 *
 * `AgentRegistry` loads built-ins by importing each `*Agent` file and calling
 * `new` on every export that extends `BasicAgent`. `PythonAgent` is a wrapper
 * the registry builds once per descriptor found in a user's `.py` file, so it
 * requires `(file, descriptor)` — and discovery reached it, threw on
 * `descriptor.name`, and logged
 *
 *     WARN [agents] Agent file failed to load {"file":".../PythonAgent.js",
 *       "reason":"Cannot read properties of undefined (reading 'name')"}
 *
 * on every single CLI invocation, while recording a permanent false entry in
 * `getLoadFailures()`.
 *
 * The warning was the only symptom, and it had been printing in plain sight
 * above `--list-agents` output. This test is the thing that would have failed.
 *
 * Note on the fix: constructor arity looks like a tidy way to detect "cannot be
 * built bare", and is wrong. An optional TypeScript parameter still counts
 * toward `Function.length`, so `ShellAgent` reports arity 1 while constructing
 * perfectly well with no arguments. Only an explicit marker distinguishes a
 * template from an agent, which is why `isTemplate` exists.
 */

/** The built-in agent files exactly as `AgentRegistry` selects them. */
function builtinAgentFiles(): string[] {
  return fs
    .readdirSync(agentsSrcDir)
    .filter((f) => f.endsWith('Agent.ts'))
    .filter((f) => !f.startsWith('Basic') && !f.startsWith('_'))
    .filter((f) => !f.endsWith('.test.ts'));
}

describe('built-in agent discovery', () => {
  it('finds a non-trivial number of built-in agent files', () => {
    // Anti-vacuity: a broken filter would otherwise make every assertion below
    // pass by having nothing to assert against.
    expect(builtinAgentFiles().length).toBeGreaterThan(20);
  });

  it('constructs every discoverable built-in agent with no arguments', async () => {
    const failures: string[] = [];
    let constructed = 0;
    let templatesSkipped = 0;

    for (const file of builtinAgentFiles()) {
      const modulePath = path.join(agentsSrcDir, file);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
      } catch (error) {
        failures.push(`${file} failed to import: ${(error as Error).message}`);
        continue;
      }

      for (const [exportName, exported] of Object.entries(mod)) {
        if (typeof exported !== 'function') continue;
        if (!(exported.prototype instanceof BasicAgent)) continue;

        // Mirrors the registry's own skip, so a template is not a failure.
        if ((exported as { isTemplate?: boolean }).isTemplate) {
          templatesSkipped++;
          continue;
        }

        try {
          new (exported as new () => BasicAgent)();
          constructed++;
        } catch (error) {
          failures.push(
            `${file} → ${exportName} cannot be constructed with no arguments: ` +
              `${(error as Error).message}. Either give it a no-argument path, or mark it ` +
              `\`static readonly isTemplate = true\` if the registry builds it some other way.`,
          );
        }
      }
    }

    expect(constructed, 'discovery should construct many agents').toBeGreaterThan(20);
    expect(failures, failures.join('\n')).toEqual([]);
    // PythonAgent is the template this test was written for; if it stops being
    // one, the assertion above starts covering it instead.
    expect(templatesSkipped).toBeGreaterThan(0);
  }, 120_000);
});

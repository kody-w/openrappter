import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerTelephonyCommands } from './cli.js';

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'voice-call',
  'SKILL.md',
);

function documentedCallCommands(): string[] {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  return [...skill.matchAll(/\bopenrappter call ([a-z][a-z-]*)\b/g)]
    .map((match) => match[1]);
}

function registeredCallCommands(): string[] {
  const program = new Command();
  registerTelephonyCommands(program);
  const call = program.commands.find((command) => command.name() === 'call');
  if (!call) throw new Error('call command was not registered');
  return call.commands.map((command) => command.name());
}

describe('bundled voice-call skill', () => {
  it('documents only subcommands the shipped CLI actually registers', () => {
    const registered = registeredCallCommands();
    const documented = documentedCallCommands();

    expect(documented.length).toBeGreaterThan(0);
    expect(documented.filter((command) => !registered.includes(command))).toEqual([]);
  });

  it('does not require a legacy plugin switch the CLI never reads', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).not.toContain('plugins.entries.voice-call.enabled');
  });
});

import { describe, it, expect } from 'vitest';
import { parseSlashCommand, commands, executeSlashCommand } from '../../tui/slash-commands.js';
import * as theme from '../../tui/theme.js';
import * as md from '../../tui/markdown.js';
import * as gc from '../../tui/gateway-client.js';

describe('Slash Command Parsing', () => {
  it('should parse simple command', () => {
    expect(parseSlashCommand('/help')).toEqual({ command: 'help', args: '' });
  });

  it('should parse command with args', () => {
    expect(parseSlashCommand('/agent myagent')).toEqual({ command: 'agent', args: 'myagent' });
  });

  it('should parse command with multiple args', () => {
    expect(parseSlashCommand('/session my session name')).toEqual({ command: 'session', args: 'my session name' });
  });

  it('should return null for non-slash input', () => {
    expect(parseSlashCommand('hello')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseSlashCommand('')).toBeNull();
  });

  it('should lowercase command', () => {
    expect(parseSlashCommand('/HELP')?.command).toBe('help');
  });
});

describe('Built-in Commands', () => {
  it('should have required commands', () => {
    const commandNames = commands.map(cmd => cmd.name);
    const requiredCommands = ['help', 'status', 'agent', 'session', 'model', 'new', 'reset', 'abort', 'quit'];

    for (const required of requiredCommands) {
      expect(commandNames).toContain(required);
    }
  });

  it('should have at least 9 commands', () => {
    expect(commands.length).toBeGreaterThanOrEqual(9);
  });

  it('each command should have name, description, execute', () => {
    for (const cmd of commands) {
      expect(cmd.name).toBeDefined();
      expect(typeof cmd.name).toBe('string');
      expect(cmd.description).toBeDefined();
      expect(typeof cmd.description).toBe('string');
      expect(cmd.execute).toBeDefined();
    }
  });

  it('each execute should be a function', () => {
    for (const cmd of commands) {
      expect(typeof cmd.execute).toBe('function');
    }
  });
});

describe('Command Execution', () => {
  it('help should return command list', async () => {
    const mockClient = {} as any;
    const { result } = await executeSlashCommand('/help', mockClient);
    expect(result).toContain('/help');
  });

  it('quit should signal exit', async () => {
    const { isQuit } = await executeSlashCommand('/quit', {} as any);
    expect(isQuit).toBe(true);
  });

  it('unknown command should return error', async () => {
    const { result } = await executeSlashCommand('/nonexistent', {} as any);
    expect(result).toContain('Unknown command');
  });

  it('non-slash should return null result', async () => {
    const { result, isQuit } = await executeSlashCommand('hello', {} as any);
    expect(result).toBeNull();
    expect(isQuit).toBe(false);
  });
});

describe('TUI Module Structure', () => {
  it('verify theme module exists', () => {
    expect(theme).toBeDefined();
  });

  it('verify markdown module exists', () => {
    expect(md).toBeDefined();
  });

  it('verify gateway-client module exists', () => {
    expect(gc).toBeDefined();
  });
});

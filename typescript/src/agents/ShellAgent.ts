/**
 * ShellAgent - Shell command and file operations agent.
 *
 * Provides bash command execution, file reading/writing, and directory listing.
 * The core "hands" of the assistant for interacting with the system.
 *
 * Mirrors Python agents/shell_agent.py
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const execAsync = promisify(exec);

export class ShellAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Shell',
      description: 'Executes shell commands and file operations. Use this to run commands, read files, write files, or list directories.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['bash', 'read', 'write', 'list'],
          },
          command: {
            type: 'string',
            description: "Shell command to execute (for 'bash' action).",
          },
          path: {
            type: 'string',
            description: 'File or directory path (for read/write/list actions).',
          },
          content: {
            type: 'string',
            description: "Content to write (for 'write' action).",
          },
          query: {
            type: 'string',
            description: 'Natural language query that may contain the command or path.',
          },
        },
        required: [],
      },
    };
    super('Shell', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    let action = kwargs.action as string | undefined;
    let command = kwargs.command as string | undefined;
    let filePath = kwargs.path as string | undefined;
    const content = kwargs.content as string | undefined;
    const query = kwargs.query as string | undefined;

    // Try to infer action from query if not specified
    if (!action && query) {
      const parsed = this.parseQuery(query);
      action = parsed.action;
      command = parsed.command || command;
      filePath = parsed.path || filePath;
    }

    if (action === 'bash' || (command && !action)) {
      return this.executeBash(command || query || '');
    } else if (action === 'read') {
      return this.readFile(filePath || query || '');
    } else if (action === 'write') {
      return this.writeFile(filePath || '', content || '');
    } else if (action === 'list') {
      return this.listDirectory(filePath || '.');
    } else {
      // Default: try as bash command
      if (query) {
        return this.executeBash(query);
      }
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: bash, read, write, or list',
      });
    }
  }

  private parseQuery(query: string): { action?: string; command?: string; path?: string } {
    const qLower = query.toLowerCase();

    // Detect bash commands
    for (const prefix of ['run ', 'execute ', '$ ']) {
      if (qLower.startsWith(prefix)) {
        return { action: 'bash', command: query.slice(prefix.length) };
      }
    }

    // Detect file read
    for (const prefix of ['read ', 'show ', 'cat ']) {
      if (qLower.startsWith(prefix)) {
        return { action: 'read', path: query.slice(prefix.length).trim() };
      }
    }

    // Detect directory listing
    if (qLower === 'ls' || qLower === 'dir') {
      return { action: 'list', path: '.' };
    }
    if (qLower.startsWith('list ')) {
      return { action: 'list', path: query.slice(5).trim() || '.' };
    }

    // Default to bash
    return { action: 'bash', command: query };
  }

  private async executeBash(command: string): Promise<string> {
    if (!command) {
      return JSON.stringify({ status: 'error', message: 'No command provided' });
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30000,
        cwd: process.cwd(),
      });

      const output = stdout || stderr;
      return JSON.stringify({
        status: 'success',
        command,
        output: output ? output.slice(0, 2000) : '(no output)',
        return_code: 0,
      });
    } catch (error) {
      const err = error as Error & { code?: number; killed?: boolean };
      if (err.killed) {
        return JSON.stringify({
          status: 'error',
          message: 'Command timed out after 30 seconds',
        });
      }
      return JSON.stringify({
        status: 'error',
        message: err.message,
      });
    }
  }

  private async readFile(filePath: string): Promise<string> {
    if (!filePath) {
      return JSON.stringify({ status: 'error', message: 'No file path provided' });
    }

    try {
      const resolvedPath = path.resolve(filePath.replace(/^~/, process.env.HOME || ''));
      const stats = await fs.stat(resolvedPath);

      if (stats.isDirectory()) {
        return this.listDirectory(filePath);
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      const truncated = content.length > 5000;

      return JSON.stringify({
        status: 'success',
        path: resolvedPath,
        content: truncated ? content.slice(0, 5000) : content,
        truncated,
        size: content.length,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return JSON.stringify({ status: 'error', message: `File not found: ${filePath}` });
      }
      return JSON.stringify({ status: 'error', message: err.message });
    }
  }

  private async writeFile(filePath: string, content: string): Promise<string> {
    if (!filePath) {
      return JSON.stringify({ status: 'error', message: 'No file path provided' });
    }
    if (!content) {
      return JSON.stringify({ status: 'error', message: 'No content provided to write' });
    }

    try {
      const resolvedPath = path.resolve(filePath.replace(/^~/, process.env.HOME || ''));
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content);

      return JSON.stringify({
        status: 'success',
        path: resolvedPath,
        bytes_written: content.length,
        message: `Wrote ${content.length} bytes to ${resolvedPath}`,
      });
    } catch (error) {
      return JSON.stringify({ status: 'error', message: (error as Error).message });
    }
  }

  private async listDirectory(dirPath: string = '.'): Promise<string> {
    try {
      const resolvedPath = path.resolve(dirPath.replace(/^~/, process.env.HOME || ''));
      const stats = await fs.stat(resolvedPath);

      if (!stats.isDirectory()) {
        return this.readFile(dirPath);
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const items = await Promise.all(
        entries.slice(0, 50).map(async (entry) => {
          const entryPath = path.join(resolvedPath, entry.name);
          let size: number | null = null;
          if (entry.isFile()) {
            try {
              const entryStats = await fs.stat(entryPath);
              size = entryStats.size;
            } catch {
              // Ignore stat errors
            }
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size,
          };
        })
      );

      return JSON.stringify({
        status: 'success',
        path: resolvedPath,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
        count: items.length,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return JSON.stringify({ status: 'error', message: `Directory not found: ${dirPath}` });
      }
      return JSON.stringify({ status: 'error', message: err.message });
    }
  }
}

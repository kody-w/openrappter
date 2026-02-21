/**
 * LearnNewAgent - Meta-agent that creates new agents from natural language.
 *
 * Describe what you want the agent to do and LearnNewAgent generates,
 * saves, and hot-loads it — agents building agents in real-time.
 * Generated agents follow the Single File Agent pattern: one file
 * containing documentation, metadata contract, and deterministic code.
 *
 * Mirrors Python agents/learn_new_agent.py
 *
 * Generated agents are JavaScript ESM modules using a factory pattern:
 *   export function createAgent(BasicAgent) { ... return AgentClass; }
 * This avoids import resolution issues — the host passes BasicAgent in.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const execAsync = promisify(exec);

export class LearnNewAgent extends BasicAgent {
  private agentsDir: string;
  private loadedAgents: Map<string, BasicAgent> = new Map();

  /** Stop words filtered during name generation — matches Python parity */
  private readonly STOP_WORDS = new Set([
    'that', 'this', 'with', 'from', 'agent', 'create', 'make',
    'want', 'should', 'would', 'could',
  ]);

  /** Core agent files that cannot be deleted */
  private readonly coreAgentFiles = [
    'BasicAgent.ts', 'ShellAgent.ts', 'MemoryAgent.ts',
    'LearnNewAgent.ts', 'AgentRegistry.ts', 'Assistant.ts',
    // Also protect .js variants in case someone puts them in the agents dir
    'basic_agent.js', 'shell_agent.js', 'learn_new_agent.js',
    'memory_agent.js',
  ];

  constructor(agentsDir?: string) {
    const metadata: AgentMetadata = {
      name: 'LearnNew',
      description:
        'Creates new agents from natural language descriptions. Describe what you want the agent to do and it will generate, save, and hot-load it.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Natural language description of what the new agent should do.',
          },
          name: {
            type: 'string',
            description: 'Name for the new agent (optional, will be generated from description).',
          },
          action: {
            type: 'string',
            description: 'Action to perform.',
            enum: ['create', 'list', 'delete'],
          },
          query: {
            type: 'string',
            description: 'Natural language query that may contain the agent description.',
          },
        },
        required: [],
      },
    };
    super('LearnNew', metadata);
    this.agentsDir = agentsDir ?? path.join(os.homedir(), '.openrappter', 'agents');
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || 'create';
    let description = (kwargs.description as string) || '';
    const name = (kwargs.name as string) || '';
    const query = (kwargs.query as string) || '';

    // Use query as description if description not provided
    if (!description && query) {
      description = query;
    }

    if (action === 'list') {
      return this.listGeneratedAgents();
    } else if (action === 'delete') {
      return this.deleteAgent(name || description);
    } else {
      return this.createAgent(description, name);
    }
  }

  // ── Create ───────────────────────────────────────────────────────

  private async createAgent(description: string, name: string = ''): Promise<string> {
    if (!description) {
      return JSON.stringify({
        status: 'error',
        message: 'Please provide a description of what the agent should do.',
      });
    }

    // Generate agent name from description if not provided
    if (!name) {
      name = this.generateName(description);
    }

    // Sanitize name
    name = this.sanitizeName(name);
    const className = `${name}Agent`;
    const fileName = `${this.toSnakeCase(name)}_agent.js`;

    // Ensure agents directory exists
    await fs.mkdir(this.agentsDir, { recursive: true });

    const filePath = path.join(this.agentsDir, fileName);

    // Check if agent already exists
    try {
      await fs.access(filePath);
      return JSON.stringify({
        status: 'error',
        message: `Agent '${name}' already exists at ${filePath}`,
      });
    } catch {
      // File doesn't exist — good
    }

    // Generate agent code
    const agentCode = this.generateAgentCode(description, name, className);

    // Write agent file
    try {
      await fs.writeFile(filePath, agentCode);
    } catch (e) {
      return JSON.stringify({
        status: 'error',
        message: `Failed to write agent file: ${(e as Error).message}`,
      });
    }

    // Hot-load the agent
    const hotLoadResult = await this.hotLoadAgent(filePath, className, name);

    const result: Record<string, unknown> = {
      status: 'success',
      message: `Created and loaded agent '${name}'`,
      agent_name: name,
      file_path: filePath,
      hot_loaded: hotLoadResult.success,
      description: description.slice(0, 200),
    };

    if (hotLoadResult.installed_deps) {
      result.installed_dependencies = hotLoadResult.installed_deps;
    }
    if (!hotLoadResult.success) {
      result.hot_load_error = hotLoadResult.error;
      if (hotLoadResult.hint) {
        result.hint = hotLoadResult.hint;
      }
    }

    return JSON.stringify(result);
  }

  // ── Name Generation ──────────────────────────────────────────────

  private generateName(description: string): string {
    // Try Copilot CLI first
    try {
      const result = this.tryGenerateNameViaCopilot(description);
      if (result) return result;
    } catch {
      // Copilot not available, use fallback
    }

    // Fallback: extract key words
    const words = description.toLowerCase().split(/\s+/);
    const keywords = words.filter(
      w => w.length > 3 && !this.STOP_WORDS.has(w)
    );

    if (keywords.length > 0) {
      return keywords
        .slice(0, 2)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
    }
    return 'Custom';
  }

  private tryGenerateNameViaCopilot(description: string): string | null {
    // Synchronous check — we don't await because name generation
    // should be fast. Copilot is optional enhancement.
    // This is intentionally a no-op for now; Copilot integration
    // can be wired in later by overriding this method.
    return null;
  }

  // ── Sanitization ─────────────────────────────────────────────────

  private sanitizeName(name: string): string {
    // Remove non-alphanumeric
    name = name.replace(/[^a-zA-Z0-9]/g, '');
    // Ensure starts with letter
    if (name && !/^[a-zA-Z]/.test(name)) {
      name = 'Agent' + name;
    }
    // Capitalize first letter
    if (name) {
      name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name || 'Custom';
  }

  private toSnakeCase(name: string): string {
    // CamelCase → snake_case (mirrors Python's re.sub approach)
    let s = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    return s.toLowerCase();
  }

  // ── Code Generation ──────────────────────────────────────────────

  private generateAgentCode(description: string, name: string, className: string): string {
    const performBody = this.generatePerformBody(description);
    const extraParams = this.generateExtraParams(description);
    const extraImports = this.generateExtraImports(description);
    const safeDesc = description.replace(/"/g, '\\"').replace(/\n/g, ' ');
    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');

    // Build extra params as object literal entries
    let extraParamsStr = '';
    for (const [key, param] of Object.entries(extraParams)) {
      const p = param as { type: string; description: string };
      extraParamsStr += `,\n            ${key}: { type: '${p.type}', description: '${p.description}' }`;
    }

    // Build imports section
    let importsStr = '';
    if (extraImports.length > 0) {
      importsStr = extraImports.join('\n') + '\n';
    }

    return `/**
 * ${description}
 *
 * Auto-generated by LearnNewAgent on ${date}.
 */

${importsStr}
/**
 * Factory function — receives BasicAgent base class from the host.
 * This avoids import resolution issues for dynamically generated agents.
 */
export function createAgent(BasicAgent) {
  class ${className} extends BasicAgent {
    constructor() {
      const metadata = {
        name: '${name}',
        description: "${safeDesc.slice(0, 200)}",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "The user's request or input." }${extraParamsStr}
          },
          required: []
        }
      };
      super('${name}', metadata);
    }

    async perform(kwargs) {
      const query = kwargs.query || '';
${performBody}
    }
  }

  return ${className};
}
`;
  }

  private generatePerformBody(description: string): string {
    // Simple echo/process implementation — Copilot integration can enhance this later
    return `      if (!query) {
        return JSON.stringify({
          status: 'error',
          message: 'No query provided'
        });
      }

      return JSON.stringify({
        status: 'success',
        query,
        result: \`Processed by \${this.name}: \${query}\`
      });`;
  }

  private generateExtraParams(description: string): Record<string, { type: string; description: string }> {
    const extra: Record<string, { type: string; description: string }> = {};
    const descLower = description.toLowerCase();

    if (['file', 'read', 'write', 'path'].some(w => descLower.includes(w))) {
      extra.path = { type: 'string', description: 'File or directory path.' };
    }
    if (['url', 'http', 'web', 'fetch'].some(w => descLower.includes(w))) {
      extra.url = { type: 'string', description: 'URL to access.' };
    }
    if (['number', 'count', 'amount', 'limit'].some(w => descLower.includes(w))) {
      extra.count = { type: 'integer', description: 'Number or count value.' };
    }

    return extra;
  }

  private generateExtraImports(description: string): string[] {
    const imports: string[] = [];
    const descLower = description.toLowerCase();

    const importMap: [string[], string][] = [
      [['http', 'api', 'fetch', 'url', 'web', 'request'], "import https from 'https';"],
      [['csv', 'spreadsheet'], "import fs from 'fs';"],
      [['file', 'read', 'write', 'path'], "import fs from 'fs/promises';"],
      [['base64', 'encode', 'decode'], "import { Buffer } from 'buffer';"],
      [['hash', 'md5', 'sha'], "import { createHash } from 'crypto';"],
      [['sleep', 'wait', 'delay'], "import { setTimeout } from 'timers/promises';"],
      [['environment', 'env var'], "import { env } from 'process';"],
      [['child', 'process', 'exec', 'spawn'], "import { exec } from 'child_process';"],
    ];

    for (const [keywords, importStmt] of importMap) {
      if (keywords.some(kw => descLower.includes(kw))) {
        if (!imports.includes(importStmt)) {
          imports.push(importStmt);
        }
      }
    }

    return imports;
  }

  private generateTags(description: string): string[] {
    const tags: string[] = [];
    const descLower = description.toLowerCase();

    const tagMap: Record<string, string> = {
      weather: 'weather',
      api: 'api',
      web: 'web',
      file: 'filesystem',
      data: 'data',
      search: 'search',
      email: 'email',
      database: 'database',
      sql: 'database',
      news: 'news',
      schedule: 'scheduling',
      voice: 'voice',
    };

    for (const [keyword, tag] of Object.entries(tagMap)) {
      if (descLower.includes(keyword) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return tags.length > 0 ? tags : ['custom'];
  }

  // ── Hot Loading ──────────────────────────────────────────────────

  private async hotLoadAgent(
    filePath: string,
    className: string,
    agentName: string,
  ): Promise<{ success: boolean; error?: string; hint?: string; installed_deps?: string[] }> {
    try {
      // Read code to detect missing dependencies
      const code = await fs.readFile(filePath, 'utf-8');
      const missingDeps = this.detectMissingImports(code);
      let installedDeps: string[] | undefined;

      if (missingDeps.length > 0) {
        const installResult = await this.installDependencies(missingDeps);
        if (!installResult.success) {
          return {
            success: false,
            error: `Failed to install dependencies: ${installResult.error}`,
          };
        }
        installedDeps = missingDeps;
      }

      // Dynamic import with cache busting (Node caches by URL)
      const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
      const mod = await import(fileUrl);

      if (typeof mod.createAgent !== 'function') {
        return { success: false, error: 'Module does not export createAgent factory' };
      }

      // Call factory with BasicAgent base class
      const AgentClass = mod.createAgent(BasicAgent);
      if (!AgentClass) {
        return { success: false, error: 'createAgent factory returned null' };
      }

      // Instantiate and register
      const instance = new AgentClass() as BasicAgent;
      this.loadedAgents.set(agentName, instance);

      const result: { success: boolean; installed_deps?: string[] } = { success: true };
      if (installedDeps) {
        result.installed_deps = installedDeps;
      }
      return result;
    } catch (e) {
      const err = e as Error;
      // Check for missing module errors
      if (err.message?.includes('Cannot find module') || err.message?.includes('ERR_MODULE_NOT_FOUND')) {
        const match = err.message.match(/'([^']+)'/);
        const missing = match ? match[1] : 'unknown';
        return {
          success: false,
          error: `Missing module: ${missing}`,
          hint: `Try: npm install ${missing}`,
        };
      }
      return { success: false, error: err.message };
    }
  }

  // ── Dependency Management ────────────────────────────────────────

  private detectMissingImports(code: string): string[] {
    const missing: string[] = [];
    const nodeBuiltins = new Set([
      'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
      'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
      'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
      'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
      'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
      'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
      // Also include node: prefixed and fs/promises etc.
      'timers/promises', 'fs/promises', 'stream/promises',
    ]);

    // Match import statements: import X from 'pkg' or import { X } from 'pkg'
    const importPattern = /import\s+(?:.*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g;
    let match;
    while ((match = importPattern.exec(code)) !== null) {
      const pkg = match[1];
      // Extract the base package name (e.g., 'lodash/fp' → 'lodash')
      const basePkg = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];

      if (!nodeBuiltins.has(pkg) && !nodeBuiltins.has(basePkg)) {
        if (!missing.includes(basePkg)) {
          missing.push(basePkg);
        }
      }
    }

    return missing;
  }

  private async installDependencies(packages: string[]): Promise<{ success: boolean; error?: string }> {
    if (packages.length === 0) return { success: true };

    try {
      for (const pkg of packages) {
        const { stderr } = await execAsync(`npm install --save ${pkg}`, {
          timeout: 60000,
          cwd: process.cwd(),
        });
        if (stderr && stderr.includes('ERR!')) {
          return { success: false, error: `npm install ${pkg} failed: ${stderr}` };
        }
      }
      return { success: true };
    } catch (e) {
      const err = e as Error & { killed?: boolean };
      if (err.killed) {
        return { success: false, error: 'npm install timed out' };
      }
      return { success: false, error: err.message };
    }
  }

  // ── List ─────────────────────────────────────────────────────────

  private async listGeneratedAgents(): Promise<string> {
    const agents: { name: string; file: string; auto_generated: boolean }[] = [];

    try {
      await fs.access(this.agentsDir);
    } catch {
      // Directory doesn't exist yet
      return JSON.stringify({ status: 'success', agents: [], count: 0 });
    }

    try {
      const files = await fs.readdir(this.agentsDir);
      const agentFiles = files.filter(f => f.endsWith('_agent.js'));

      for (const file of agentFiles) {
        // Skip core agents (by checking name patterns)
        if (this.coreAgentFiles.includes(file)) continue;

        const content = await fs.readFile(path.join(this.agentsDir, file), 'utf-8');
        const isGenerated = content.includes('Auto-generated by LearnNewAgent');

        agents.push({
          name: file.replace('_agent.js', ''),
          file,
          auto_generated: isGenerated,
        });
      }
    } catch {
      // Error reading directory
    }

    return JSON.stringify({
      status: 'success',
      agents,
      count: agents.length,
    });
  }

  // ── Delete ───────────────────────────────────────────────────────

  private async deleteAgent(name: string): Promise<string> {
    if (!name) {
      return JSON.stringify({
        status: 'error',
        message: 'Please provide the agent name to delete.',
      });
    }

    // Find the agent file
    const snakeName = this.toSnakeCase(this.sanitizeName(name));
    let filePath = path.join(this.agentsDir, `${snakeName}_agent.js`);

    try {
      await fs.access(filePath);
    } catch {
      // Try fuzzy match
      let found = false;
      try {
        const files = await fs.readdir(this.agentsDir);
        for (const f of files) {
          if (f.endsWith('_agent.js') && f.toLowerCase().includes(name.toLowerCase())) {
            filePath = path.join(this.agentsDir, f);
            found = true;
            break;
          }
        }
      } catch {
        // Directory doesn't exist
      }

      if (!found) {
        return JSON.stringify({
          status: 'error',
          message: `Agent '${name}' not found.`,
        });
      }
    }

    // Prevent deleting core agents
    const fileName = path.basename(filePath);
    if (this.coreAgentFiles.includes(fileName)) {
      return JSON.stringify({
        status: 'error',
        message: 'Cannot delete core agents.',
      });
    }

    try {
      await fs.unlink(filePath);
      // Also remove from loaded agents
      this.loadedAgents.delete(name);
      return JSON.stringify({
        status: 'success',
        message: `Deleted agent '${name}'`,
        file: filePath,
      });
    } catch (e) {
      return JSON.stringify({
        status: 'error',
        message: (e as Error).message,
      });
    }
  }
}

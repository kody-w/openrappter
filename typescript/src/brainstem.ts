/**
 * OpenRappter Brainstem — the TypeScript rapp/1 kernel.
 *
 * The gateway can call a Python brainstem, but until this module existed the
 * TypeScript runtime could not itself occupy that wire. This is the native
 * Node implementation of `python/openrappter/brainstem.py`: the same HTTP
 * routes, frozen chat envelope, three-round tool loop, disk-hot agent loading,
 * Copilot authentication chain, soul prompt, and local Azure-storage shim.
 *
 * Dropped agents are deliberately loaded from rewritten private cache modules.
 * Node ESM has no `sys.modules` equivalent that can alias `basic_agent` for one
 * import. Rewriting only the known BasicAgent/storage specifiers gives the same
 * guarantee without a process-global loader hook: standalone files see the
 * kernel shims and Node builtins, while undeclared package internals fail.
 */

import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { BasicAgent } from './agents/BasicAgent.js';
import type { AgentMetadata } from './agents/types.js';
import { agentResultIsError } from './agents/result-status.js';
import { buildChatEnvelope } from './gateway/chat-envelope.js';
import { parseChatRequest, type ChatHistoryMessage } from './gateway/chat-request.js';
import { openrappterHome } from './infra/openrappter-home.js';
import { logger } from './logging/logger.js';
import { VERSION } from './version.js';

const execFileAsync = promisify(execFile);
const brainstemLog = logger.child('brainstem');

export const MAX_TOOL_ROUNDS = 3;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_BRAINSTEM_PORT = 7072;
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const BACKEND_KIND = 'copilot-api';
export const RESERVED_AGENT_DIRS = ['experimental_agents', 'disabled_agents'] as const;

type JsonObject = Record<string, unknown>;

export interface BrainstemToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments?: string };
}

export interface BrainstemMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: BrainstemToolCall[];
}

export interface BrainstemLlmResult {
  message: BrainstemMessage;
  servedModel?: string;
  requestedModel: string;
}

export interface BrainstemAgent {
  name: string;
  metadata: AgentMetadata;
  perform(kwargs?: Record<string, unknown>): string | Promise<string>;
  execute?(kwargs?: Record<string, unknown>): string | Promise<string>;
  systemContext?(): string | null | Promise<string | null>;
  system_context?(): string | null | Promise<string | null>;
  toTool?(): ReturnType<BasicAgent['toTool']>;
}

export interface CopilotSession {
  token: string;
  endpoint: string;
  expiresAt: number;
  directCapi: boolean;
}

export interface BrainstemOptions {
  home?: string;
  agentsPath?: string;
  packagedAgentsPath?: string;
  soulPath?: string;
  model?: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  llmChat?: (
    messages: BrainstemMessage[],
    tools: ReturnType<typeof toTool>[],
  ) => Promise<BrainstemLlmResult>;
}

interface PendingLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

interface IdempotencyEntry {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<JsonObject>;
}

const BASIC_AGENT_SPECIFIERS = new Set([
  './BasicAgent.js',
  './BasicAgent.ts',
  './basic_agent.js',
  './basic_agent.ts',
  'basic_agent',
  'agents/basic_agent',
  'openrappter/agents/basic_agent',
]);
const STORAGE_SPECIFIERS = new Set([
  'utils/azure_file_storage',
  'utils/azure_file_storage.js',
]);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]);
const IMPORT_SPECIFIER = /^(\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?)(['"])([^'"]+)\2/gm;
const DYNAMIC_IMPORT_SPECIFIER = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = 'application/json',
): void {
  const payload = contentType === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(payload as string | Buffer),
  });
  res.end(payload);
}

async function walkAgentFiles(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if ((RESERVED_AGENT_DIRS as readonly string[]).includes(entry.name)) continue;
      files.push(...await walkAgentFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function isAgentFile(file: string, userDropIn: boolean): boolean {
  const name = path.basename(file);
  if (/^BasicAgent\.(?:js|ts)$/.test(name)) return false;
  if (userDropIn) {
    return /(?:_agent|Agent)\.(?:js|mjs|ts)$/.test(name);
  }
  return /Agent\.(?:js|ts)$/.test(name);
}

async function atomicPrivateWrite(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700).catch(() => undefined);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class LocalStorageManager {
  private context: string | null = null;
  currentGuid: string | null = null;
  readonly home: string;

  constructor(home?: string, ..._ignored: unknown[]) {
    this.home = home ?? path.join(openrappterHome(), 'brainstem');
  }

  private file(): string {
    return path.join(
      this.home,
      this.context ? `memory_${this.context}.json` : 'memory.json',
    );
  }

  async readJson(..._ignored: unknown[]): Promise<JsonObject> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), 'utf8'));
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async writeJson(data: unknown, ..._ignored: unknown[]): Promise<boolean> {
    await atomicPrivateWrite(this.file(), `${JSON.stringify(data, null, 2)}\n`);
    return true;
  }

  async updateJson(
    update: (current: JsonObject) => unknown | Promise<unknown>,
    ..._ignored: unknown[]
  ): Promise<unknown> {
    const next = await update(await this.readJson());
    await this.writeJson(next);
    return next;
  }

  setMemoryContext(context?: string | null, ..._ignored: unknown[]): boolean {
    this.context = context ?? null;
    this.currentGuid = this.context;
    return true;
  }

  async ensureDirectoryExists(..._ignored: unknown[]): Promise<void> {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
  }

  // Python-compatible spellings used by direct ports.
  read_json = this.readJson.bind(this);
  write_json = this.writeJson.bind(this);
  update_json = this.updateJson.bind(this);
  set_memory_context = this.setMemoryContext.bind(this);
  ensure_directory_exists = this.ensureDirectoryExists.bind(this);
  get current_guid(): string | null { return this.currentGuid; }
}

export function toTool(agent: BrainstemAgent): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: AgentMetadata['parameters'];
  };
} {
  if (typeof agent.toTool === 'function') return agent.toTool();
  return {
    type: 'function',
    function: {
      name: agent.name,
      description: agent.metadata?.description ?? '',
      parameters: agent.metadata?.parameters ?? {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  };
}

function exportedAgents(module: Record<string, unknown>): BrainstemAgent[] {
  const found: BrainstemAgent[] = [];
  if (typeof module.createAgent === 'function') {
    const AgentClass = (module.createAgent as (base: typeof BasicAgent) => new () => BrainstemAgent)(BasicAgent);
    if (typeof AgentClass === 'function') found.push(new AgentClass());
  }
  for (const [name, value] of Object.entries(module)) {
    if (
      name === 'BasicAgent'
      || name.startsWith('_')
      || typeof value !== 'function'
      || !(value as { prototype?: { perform?: unknown } }).prototype
      || typeof (value as { prototype: { perform?: unknown } }).prototype.perform !== 'function'
      || (value as { isTemplate?: boolean }).isTemplate
    ) continue;
    try {
      found.push(new (value as new () => BrainstemAgent)());
    } catch (error) {
      throw new Error(`${name} must instantiate with zero arguments: ${errorMessage(error)}`);
    }
  }
  return found;
}

async function transpileTypeScript(source: string, file: string): Promise<string> {
  const ts = await import('typescript');
  return ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      isolatedModules: true,
      esModuleInterop: true,
    },
    reportDiagnostics: false,
  }).outputText;
}

/**
 * Load one user drop-in under the kernel's isolated import contract.
 *
 * This helper is exported because the compliance subprocess uses the exact
 * production loader rather than carrying a test-only imitation that can drift.
 */
export async function loadStandaloneAgentFile(
  file: string,
  options: { agentsRoot?: string; cacheDir?: string; home?: string } = {},
): Promise<BrainstemAgent[]> {
  const root = path.resolve(options.agentsRoot ?? path.dirname(file));
  const home = options.home ?? path.join(openrappterHome(), 'brainstem');
  const cacheDir = options.cacheDir ?? path.join(home, '.agent-cache');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });

  const shimId = createHash('sha256').update(`${root}\0${home}`).digest('hex').slice(0, 16);
  const basicShim = path.join(cacheDir, `basic-agent-${shimId}.mjs`);
  const storageShim = path.join(cacheDir, `local-storage-${shimId}.mjs`);
  await atomicPrivateWrite(basicShim, `
export class BasicAgent {
  constructor(name, metadata) {
    this.name = name ?? this.name ?? 'BasicAgent';
    this.metadata = metadata ?? this.metadata ?? {
      name: this.name,
      description: 'Base agent -- override this.',
      parameters: { type: 'object', properties: {}, required: [] },
    };
  }
  async execute(kwargs = {}) { return this.perform(kwargs); }
  async perform(_kwargs = {}) { return 'Not implemented.'; }
  systemContext() { return null; }
  system_context() { return this.systemContext(); }
  toTool() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.metadata?.description ?? '',
        parameters: this.metadata?.parameters ?? { type: 'object', properties: {}, required: [] },
      },
    };
  }
}
`);
  await atomicPrivateWrite(storageShim, `
import { promises as fs } from 'node:fs';
import path from 'node:path';
export class AzureFileStorageManager {
  constructor() { this.home = ${JSON.stringify(home)}; this.context = null; this.current_guid = null; }
  file() { return path.join(this.home, this.context ? \`memory_\${this.context}.json\` : 'memory.json'); }
  async read_json() { try { return JSON.parse(await fs.readFile(this.file(), 'utf8')); } catch { return {}; } }
  async write_json(data) { await fs.mkdir(this.home, { recursive: true, mode: 0o700 }); await fs.writeFile(this.file(), JSON.stringify(data, null, 2)); return true; }
  async update_json(fn) { const next = await fn(await this.read_json()); await this.write_json(next); return next; }
  set_memory_context(value = null) { this.context = value; this.current_guid = value; return true; }
  async ensure_directory_exists() { await fs.mkdir(this.home, { recursive: true, mode: 0o700 }); }
}
`);

  const basicUrl = pathToFileURL(basicShim).href;
  const storageUrl = pathToFileURL(storageShim).href;
  const transformed = new Map<string, string>();
  const transforming = new Set<string>();

  const resolveSibling = async (owner: string, specifier: string): Promise<string> => {
    const resolved = path.resolve(path.dirname(owner), specifier);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Package-internal import is not brainstem-compliant: ${specifier}`);
    }
    try {
      if ((await fs.stat(resolved)).isFile()) return resolved;
    } catch {
      if (resolved.endsWith('.js')) {
        const typescriptFile = `${resolved.slice(0, -3)}.ts`;
        try {
          if ((await fs.stat(typescriptFile)).isFile()) return typescriptFile;
        } catch {
          // The original resolution error below names the import.
        }
      }
    }
    throw new Error(`Sibling import does not exist: ${specifier}`);
  };

  const transformFile = async (sourceFile: string): Promise<string> => {
    const absolute = path.resolve(sourceFile);
    const existing = transformed.get(absolute);
    if (existing) return existing;
    if (transforming.has(absolute)) {
      throw new Error(`Circular sibling imports are not supported: ${path.basename(absolute)}`);
    }
    transforming.add(absolute);
    try {
      let source = await fs.readFile(absolute, 'utf8');
      if (absolute.endsWith('.ts')) source = await transpileTypeScript(source, absolute);

      const resolveSpecifier = async (specifier: string): Promise<string> => {
        if (BASIC_AGENT_SPECIFIERS.has(specifier)) return basicUrl;
        if (STORAGE_SPECIFIERS.has(specifier)) return storageUrl;
        if (NODE_BUILTINS.has(specifier)) return specifier;
        if (specifier.startsWith('.')) {
          return pathToFileURL(
            await transformFile(await resolveSibling(absolute, specifier)),
          ).href;
        }
        throw new Error(`Non-builtin import is not brainstem-compliant: ${specifier}`);
      };

      const rewrite = async (
        input: string,
        expression: RegExp,
        specifierIndex: number,
      ): Promise<string> => {
        const matches = [...input.matchAll(expression)];
        if (!matches.length) return input;
        let output = '';
        let cursor = 0;
        for (const match of matches) {
          const start = match.index!;
          output += input.slice(cursor, start);
          const replacement = await resolveSpecifier(match[specifierIndex]);
          output += match[0].replace(match[specifierIndex], replacement);
          cursor = start + match[0].length;
        }
        return output + input.slice(cursor);
      };

      source = await rewrite(source, new RegExp(IMPORT_SPECIFIER), 3);
      source = await rewrite(source, new RegExp(DYNAMIC_IMPORT_SPECIFIER), 2);
      const digest = createHash('sha256')
        .update(absolute)
        .update('\0')
        .update(source)
        .digest('hex');
      const cachedFile = path.join(cacheDir, `${digest}.mjs`);
      await atomicPrivateWrite(cachedFile, source);
      transformed.set(absolute, cachedFile);
      return cachedFile;
    } finally {
      transforming.delete(absolute);
    }
  };

  const cached = await transformFile(file);
  const module = await import(`${pathToFileURL(cached).href}?v=${Date.now()}-${randomUUID()}`);
  return exportedAgents(module as Record<string, unknown>);
}

export class BrainstemKernel {
  readonly home: string;
  readonly agentsPath: string;
  readonly packagedAgentsPath: string;
  readonly soulPath: string;
  readonly model: string;
  readonly host: string;
  readonly configuredPort: number;
  readonly maxBodyBytes: number;
  readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly injectedLlmChat?: BrainstemOptions['llmChat'];
  private server: ReturnType<typeof createServer> | null = null;
  private pendingLogin: PendingLogin | null = null;
  private copilotCache: CopilotSession | null = null;
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(options: BrainstemOptions = {}) {
    this.env = options.env ?? process.env;
    const dataHome = options.home
      ? path.dirname(options.home)
      : this.env.OPENRAPPTER_HOME || openrappterHome();
    this.home = options.home ?? path.join(dataHome, 'brainstem');
    this.agentsPath = options.agentsPath
      ?? this.env.OPENRAPPTER_BRAINSTEM_AGENTS
      ?? path.join(this.home, 'agents');
    this.packagedAgentsPath = options.packagedAgentsPath
      ?? fileURLToPath(new URL('./agents/', import.meta.url));
    this.soulPath = options.soulPath
      ?? this.env.OPENRAPPTER_SOUL
      ?? path.join(dataHome, 'soul.md');
    this.model = options.model ?? this.env.OPENRAPPTER_MODEL ?? 'claude-sonnet-5';
    this.host = options.host ?? this.env.OPENRAPPTER_BRAINSTEM_HOST ?? '127.0.0.1';
    this.configuredPort = options.port
      ?? Number(this.env.PORT ?? this.env.OPENRAPPTER_BRAINSTEM_PORT ?? DEFAULT_BRAINSTEM_PORT);
    const configuredLimit = Number(this.env.OPENRAPPTER_MAX_BODY_BYTES);
    this.maxBodyBytes = options.maxBodyBytes
      ?? (Number.isFinite(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : DEFAULT_MAX_BODY_BYTES);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.injectedLlmChat = options.llmChat;
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? (address as AddressInfo).port
      : this.configuredPort;
  }

  async start(): Promise<this> {
    if (this.server) return this;
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.agentsPath, { recursive: true, mode: 0o700 });
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(error => {
        brainstemLog.error('Request failed', { error: errorMessage(error) });
        if (!res.headersSent) {
          const isChat = (req.url ?? '').split('?')[0] === '/chat';
          jsonResponse(res, 500, isChat
            ? { schema: 'rapp-chat/1.0', status: 'error', error: 'Internal error' }
            : { error: 'Internal error' });
        } else {
          res.end();
        }
      });
    });
    this.server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.configuredPort, this.host, resolve);
    });
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async loadAgents(): Promise<Map<string, BrainstemAgent>> {
    const agents = new Map<string, BrainstemAgent>();
    for (const [root, userDropIn] of [
      [this.packagedAgentsPath, false],
      [this.agentsPath, true],
    ] as const) {
      for (const file of (await walkAgentFiles(root)).filter(item => isAgentFile(item, userDropIn)).sort()) {
        try {
          const loaded = userDropIn
            ? await loadStandaloneAgentFile(file, {
                agentsRoot: this.agentsPath,
                cacheDir: path.join(this.home, '.agent-cache'),
                home: this.home,
              })
            : exportedAgents(await import(`${pathToFileURL(file).href}?v=${Date.now()}-${randomUUID()}`));
          for (const agent of loaded) agents.set(agent.name, agent);
        } catch (error) {
          brainstemLog.warn('Agent file failed to load', { file, error: errorMessage(error) });
        }
      }
    }
    return agents;
  }

  async loadSoul(): Promise<string> {
    try {
      return (await fs.readFile(this.soulPath, 'utf8')).trim();
    } catch {
      return 'You are OpenRappter, a helpful local-first AI assistant.';
    }
  }

  async runChat(
    userInput: string,
    history: ChatHistoryMessage[],
    sessionId: string,
  ): Promise<JsonObject> {
    const agents = await this.loadAgents();
    const tools = [...agents.values()].map(toTool);
    let systemPrompt = await this.loadSoul();
    for (const agent of agents.values()) {
      const hook = agent.systemContext ?? agent.system_context;
      if (typeof hook !== 'function') continue;
      try {
        const extra = await hook.call(agent);
        if (typeof extra === 'string' && extra.trim()) {
          systemPrompt += `\n\n${extra.trim()}`;
        }
      } catch {
        // One context hook cannot take down the turn.
      }
    }

    const messages: BrainstemMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userInput },
    ];
    const agentLogs: string[] = [];
    let lastContent = '';
    let servedModel: string | undefined;
    let requestedModel = this.model;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await this.llmChat(messages, tools);
      servedModel = reply.servedModel;
      requestedModel = reply.requestedModel;
      if (typeof reply.message.content === 'string' && reply.message.content) {
        lastContent = reply.message.content;
      }
      const calls = reply.message.tool_calls;
      if (!calls?.length) {
        return buildChatEnvelope({
          content: reply.message.content ?? '',
          sessionId,
          agentLogs,
          model: servedModel,
          requestedModel,
          backendKind: BACKEND_KIND,
        });
      }

      messages.push(reply.message);
      for (const call of calls) {
        const name = call.function.name;
        let kwargs: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments || '{}');
          if (isObject(parsed)) kwargs = parsed;
        } catch {
          kwargs = {};
        }
        delete kwargs._trusted_context;
        delete kwargs._transport_event_id;
        const agent = agents.get(name);
        let result: string;
        let logLine: string;
        if (!agent) {
          result = `Agent '${name}' not found.`;
          logLine = result;
        } else {
          try {
            const raw = typeof agent.execute === 'function'
              ? await agent.execute(kwargs)
              : await agent.perform(kwargs);
            result = String(raw);
            logLine = result;
          } catch (error) {
            result = `Error: ${errorMessage(error)}`;
            logLine = `ERROR: ${errorMessage(error)}`;
          }
        }
        // Parsing here is intentional: the classification is part of the
        // recorder contract in Python, while the wire always carries the text.
        agentResultIsError(result);
        agentLogs.push(`[${name}] ${logLine}`);
        messages.push({
          tool_call_id: call.id ?? name,
          role: 'tool',
          name,
          content: result,
        });
      }
    }

    return buildChatEnvelope({
      content: lastContent,
      sessionId,
      agentLogs,
      model: servedModel,
      requestedModel,
      backendKind: BACKEND_KIND,
    });
  }

  async githubToken(): Promise<string | null> {
    const fromEnv = this.env.COPILOT_GITHUB_TOKEN || this.env.GITHUB_TOKEN || this.env.GH_TOKEN;
    if (fromEnv?.trim()) return fromEnv.trim();
    const saved = await this.readTokenFile();
    if (typeof saved?.access_token === 'string' && saved.access_token) return saved.access_token;
    try {
      const profile = JSON.parse(await fs.readFile(
        path.join(path.dirname(this.home), 'credentials', 'github-token.json'),
        'utf8',
      ));
      if (typeof profile.token === 'string' && profile.token.trim()) return profile.token.trim();
    } catch {
      // No shared profile.
    }
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
        timeout: 10_000,
        env: this.env,
      });
      const token = stdout.trim();
      return token.startsWith('ghu_') ? token : null;
    } catch {
      return null;
    }
  }

  async copilotSession(): Promise<CopilotSession | null> {
    if (this.copilotCache && Date.now() / 1000 < this.copilotCache.expiresAt - 60) {
      return this.copilotCache;
    }
    const githubToken = await this.githubToken();
    if (!githubToken) return null;
    if (githubToken.startsWith('gho_') || githubToken.startsWith('github_pat_')) {
      this.copilotCache = {
        token: githubToken,
        endpoint: this.env.OPENRAPPTER_COPILOT_CAPI_URL
          ?? 'https://api.enterprise.githubcopilot.com',
        expiresAt: Date.now() / 1000 + 3600,
        directCapi: true,
      };
      return this.copilotCache;
    }
    let response = await this.exchangeCopilotToken(githubToken);
    if ([401, 403, 404].includes(response.status)) {
      const refreshed = await this.refreshGithubToken();
      if (!refreshed) return null;
      response = await this.exchangeCopilotToken(refreshed);
    }
    if (response.status !== 200 || !isObject(response.data) || typeof response.data.token !== 'string') {
      return null;
    }
    const endpoints = isObject(response.data.endpoints) ? response.data.endpoints : {};
    this.copilotCache = {
      token: response.data.token,
      endpoint: typeof endpoints.api === 'string'
        ? endpoints.api
        : 'https://api.githubcopilot.com',
      expiresAt: typeof response.data.expires_at === 'number' ? response.data.expires_at : 0,
      directCapi: false,
    };
    return this.copilotCache;
  }

  async startDeviceLogin(): Promise<{ user_code: string; verification_uri: string }> {
    if (this.pendingLogin && Date.now() < this.pendingLogin.expiresAt) {
      return {
        user_code: this.pendingLogin.userCode,
        verification_uri: this.pendingLogin.verificationUri,
      };
    }
    const data = await this.httpForm('https://github.com/login/device/code', {
      client_id: COPILOT_CLIENT_ID,
    });
    this.pendingLogin = {
      deviceCode: String(data.device_code),
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri),
      interval: typeof data.interval === 'number' ? data.interval : 5,
      expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000,
    };
    return {
      user_code: this.pendingLogin.userCode,
      verification_uri: this.pendingLogin.verificationUri,
    };
  }

  async pollDeviceLogin(): Promise<JsonObject> {
    if (!this.pendingLogin) return { status: 'idle' };
    const data = await this.httpForm('https://github.com/login/oauth/access_token', {
      client_id: COPILOT_CLIENT_ID,
      device_code: this.pendingLogin.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof data.access_token === 'string' && data.access_token) {
      await atomicPrivateWrite(this.tokenFile(), JSON.stringify({
        access_token: data.access_token,
        refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : '',
      }));
      this.pendingLogin = null;
      this.copilotCache = null;
      return { status: 'success' };
    }
    const error = String(data.error ?? 'authorization_pending');
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
    this.pendingLogin = null;
    return { status: 'error', error };
  }

  private async llmChat(
    messages: BrainstemMessage[],
    tools: ReturnType<typeof toTool>[],
  ): Promise<BrainstemLlmResult> {
    if (this.injectedLlmChat) return this.injectedLlmChat(messages, tools);
    const session = await this.copilotSession();
    if (!session) {
      throw new Error('Copilot not authenticated — set GITHUB_TOKEN or run `gh auth login`');
    }
    const requestedModel = session.directCapi
      ? this.env.OPENRAPPTER_CAPI_MODEL ?? 'gpt-4o'
      : this.model;
    const response = await this.fetchImpl(`${session.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Editor-Version': 'vscode/1.95.0',
        'Editor-Plugin-Version': 'copilot/1.0.0',
        'User-Agent': 'GitHubCopilotChat/0.22.2024',
        'Copilot-Integration-Id': 'vscode-chat',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: requestedModel,
        messages,
        tools: tools.length ? tools : null,
        ...(session.directCapi ? {} : { max_tokens: 2000 }),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 401) {
      this.copilotCache = null;
      throw new Error('Copilot token expired');
    }
    if (!response.ok) throw new Error(`Copilot chat failed: HTTP ${response.status}`);
    const data = await response.json() as JsonObject;
    const choices = data.choices as Array<{ message: BrainstemMessage }> | undefined;
    if (!choices?.[0]?.message) throw new Error('Copilot chat returned no message');
    return {
      message: choices[0].message,
      servedModel: typeof data.model === 'string' ? data.model : undefined,
      requestedModel,
    };
  }

  private async exchangeCopilotToken(token: string): Promise<{ status: number; data: unknown }> {
    const prefix = token.startsWith('ghu_') ? 'token' : 'Bearer';
    try {
      const response = await this.fetchImpl(COPILOT_TOKEN_URL, {
        headers: {
          Authorization: `${prefix} ${token}`,
          Accept: 'application/json',
          'Editor-Version': 'vscode/1.95.0',
          'Editor-Plugin-Version': 'copilot/1.0.0',
          'User-Agent': 'GitHubCopilotChat/0.22.2024',
        },
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    } catch {
      return { status: 0, data: {} };
    }
  }

  private async refreshGithubToken(): Promise<string | null> {
    const profilesPath = path.join(path.dirname(this.home), 'auth-profiles.json');
    let profiles: unknown;
    try {
      profiles = JSON.parse(await fs.readFile(profilesPath, 'utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(profiles)) return null;
    const candidates = profiles.filter((item): item is JsonObject =>
      isObject(item)
      && item.provider === 'copilot'
      && typeof item.refreshToken === 'string'
      && item.refreshToken.length > 0
    ).sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
    const profile = candidates[0];
    if (!profile) return null;
    const data = await this.httpForm('https://github.com/login/oauth/access_token', {
      client_id: COPILOT_CLIENT_ID,
      refresh_token: String(profile.refreshToken),
      grant_type: 'refresh_token',
    }).catch(() => null);
    if (!data || typeof data.access_token !== 'string' || !data.access_token) return null;
    profile.token = data.access_token;
    if (typeof data.refresh_token === 'string' && data.refresh_token) {
      profile.refreshToken = data.refresh_token;
    }
    profile.updatedAt = Date.now();
    await atomicPrivateWrite(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
    await atomicPrivateWrite(
      path.join(path.dirname(this.home), 'credentials', 'github-token.json'),
      `${JSON.stringify({
        token: data.access_token,
        savedAt: profile.updatedAt,
        source: 'device_code',
      }, null, 2)}\n`,
    );
    return data.access_token;
  }

  private async httpForm(url: string, values: Record<string, string>): Promise<JsonObject> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(15_000),
    });
    return await response.json() as JsonObject;
  }

  private tokenFile(): string {
    return path.join(this.home, '.copilot_token');
  }

  private async readTokenFile(): Promise<JsonObject | null> {
    try {
      await fs.chmod(this.tokenFile(), 0o600).catch(() => undefined);
      const raw = (await fs.readFile(this.tokenFile(), 'utf8')).trim();
      if (!raw) return null;
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        return isObject(parsed) ? parsed : null;
      }
      return { access_token: raw };
    } catch {
      return null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = (req.url ?? '/').split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method === 'GET') return this.handleGet(route, res);
    if (req.method === 'DELETE') return this.handleDelete(route, res);
    if (req.method === 'POST') {
      const body = await this.readBody(req, route, res);
      if (body === null) return;
      return this.handlePost(route, req.headers['content-type'] ?? '', body, res);
    }
    jsonResponse(res, 404, { error: 'Not found' });
  }

  private async handleGet(route: string, res: ServerResponse): Promise<void> {
    if (route === '/health') {
      const agents = await this.loadAgents();
      jsonResponse(res, 200, {
        status: 'ok',
        version: VERSION,
        agents: [...agents.keys()].sort(),
        brainstem_dir: this.home,
        soul: this.soulPath,
        model: this.model,
        copilot: await this.copilotSession() ? '✓' : '✗',
      });
      return;
    }
    if (route === '/version') {
      jsonResponse(res, 200, { version: VERSION });
      return;
    }
    if (route === '/login/status') {
      jsonResponse(res, 200, {
        authenticated: Boolean(await this.copilotSession()),
        pending: Boolean(this.pendingLogin),
        token_file: this.tokenFile(),
      });
      return;
    }
    if (route === '/models') {
      jsonResponse(res, 200, { models: [this.model], active: this.model });
      return;
    }
    if (route === '/agents') {
      const files: Array<{ filename: string; agents: string[] }> = [];
      for (const [root, userDropIn] of [
        [this.packagedAgentsPath, false],
        [this.agentsPath, true],
      ] as const) {
        for (const file of (await walkAgentFiles(root)).filter(item => isAgentFile(item, userDropIn)).sort()) {
          let names: string[] = [];
          try {
            const loaded = userDropIn
              ? await loadStandaloneAgentFile(file, { agentsRoot: root, home: this.home })
              : exportedAgents(await import(`${pathToFileURL(file).href}?v=${Date.now()}-${randomUUID()}`));
            names = loaded.map(agent => agent.name).sort();
          } catch {
            // A broken file remains visible with an empty loaded-agent list.
          }
          files.push({ filename: path.basename(file), agents: names });
        }
      }
      jsonResponse(res, 200, { files });
      return;
    }
    if (route.startsWith('/agents/export/')) {
      const filename = path.basename(route.slice('/agents/export/'.length));
      for (const root of [this.agentsPath, this.packagedAgentsPath]) {
        const target = path.join(root, filename);
        try {
          const body = await fs.readFile(target);
          jsonResponse(
            res,
            200,
            body,
            filename.endsWith('.ts') ? 'text/typescript' : 'application/javascript',
          );
          return;
        } catch {
          // Try the packaged directory.
        }
      }
      jsonResponse(res, 404, { error: `Agent file not found: ${filename}` });
      return;
    }
    if (route === '/') {
      jsonResponse(res, 200, {
        name: 'OpenRappter Brainstem',
        version: VERSION,
        docs: 'POST /chat · GET /health /agents · POST /agents/import',
      });
      return;
    }
    jsonResponse(res, 404, { error: 'Not found' });
  }

  private async handlePost(
    route: string,
    contentType: string,
    raw: Buffer,
    res: ServerResponse,
  ): Promise<void> {
    if (route === '/chat') return this.handleChat(raw, res);
    if (route === '/login') {
      try {
        jsonResponse(res, 200, await this.startDeviceLogin());
      } catch (error) {
        jsonResponse(res, 503, { error: `Could not start device login: ${errorMessage(error)}` });
      }
      return;
    }
    if (route === '/login/poll') {
      try {
        jsonResponse(res, 200, await this.pollDeviceLogin());
      } catch (error) {
        jsonResponse(res, 503, { error: `Login poll failed: ${errorMessage(error)}` });
      }
      return;
    }
    if (route === '/agents/import') {
      const parsed = this.parseMultipartFile(contentType, raw);
      if (!parsed.ok) {
        jsonResponse(res, 400, { error: parsed.error });
        return;
      }
      const ext = path.extname(parsed.filename).toLowerCase();
      if (!['.js', '.mjs', '.ts'].includes(ext)) {
        jsonResponse(res, 400, { error: 'Only .js, .mjs, and .ts files are supported' });
        return;
      }
      let filename = path.basename(parsed.filename);
      const base = filename.slice(0, -ext.length);
      if (!/(?:_agent|Agent)$/.test(base)) {
        filename = ext === '.ts' ? `${base}Agent.ts` : `${base}_agent${ext}`;
      }
      const target = path.join(this.agentsPath, filename);
      await atomicPrivateWrite(target, parsed.content);
      try {
        const agents = await loadStandaloneAgentFile(target, {
          agentsRoot: this.agentsPath,
          cacheDir: path.join(this.home, '.agent-cache'),
          home: this.home,
        });
        if (!agents.length) throw new Error('registered no agents');
      } catch (error) {
        jsonResponse(res, 200, {
          error: `Saved ${filename}, but it did not load as an agent — check the file for errors. ${errorMessage(error)}`,
        });
        return;
      }
      jsonResponse(res, 200, {
        status: 'ok',
        message: `Agent ${filename} imported successfully.`,
      });
      return;
    }
    jsonResponse(res, 404, { error: 'Not found' });
  }

  private async handleChat(raw: Buffer, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      body = undefined;
    }
    const parsed = parseChatRequest(body);
    if (!parsed.ok) {
      jsonResponse(res, 400, {
        schema: 'rapp-chat/1.0',
        status: 'error',
        error: parsed.error,
      });
      return;
    }
    const input = body as JsonObject;
    const sessionRaw = input.session_id ?? input.sessionId;
    const sessionId = sessionRaw === undefined || sessionRaw === null
      ? randomUUID()
      : String(sessionRaw);
    const idempotencyRaw = input.idempotency_key ?? input.idempotencyKey;
    const idempotencyKey = typeof idempotencyRaw === 'string' && idempotencyRaw
      ? idempotencyRaw
      : undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify({
      message: parsed.value.userInput,
      session_id: sessionRaw ?? null,
      conversation_history: parsed.value.conversationHistory,
    })).digest('hex');

    try {
      const result = await this.runIdempotent(
        idempotencyKey,
        fingerprint,
        () => this.runChat(
          parsed.value.userInput,
          parsed.value.conversationHistory,
          sessionId,
        ),
      );
      const response = String(result.response ?? '');
      const responseSessionId = String(result.session_id ?? sessionId);
      Object.assign(result, {
        schema: 'rapp-chat/1.0',
        status: 'success',
        response,
        content: response,
        session_id: responseSessionId,
        sessionId: responseSessionId,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
      jsonResponse(res, 200, result);
    } catch (error) {
      const conflict = error instanceof IdempotencyConflict;
      jsonResponse(res, conflict ? 409 : 503, {
        schema: 'rapp-chat/1.0',
        status: 'error',
        error: errorMessage(error),
        ...(conflict ? {} : { session_id: sessionId, sessionId }),
      });
    }
  }

  private async handleDelete(route: string, res: ServerResponse): Promise<void> {
    if (!route.startsWith('/agents/')) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }
    const filename = path.basename(route.slice('/agents/'.length));
    const target = path.join(this.agentsPath, filename);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error('not a file');
      await fs.unlink(target);
      jsonResponse(res, 200, { status: 'ok', message: `Deleted ${filename}` });
    } catch {
      jsonResponse(res, 404, {
        error: `Agent file not found: ${filename} (packaged agents cannot be deleted)`,
      });
    }
  }

  private async readBody(
    req: IncomingMessage,
    route: string,
    res: ServerResponse,
  ): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxBodyBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(buffer);
    }
    if (tooLarge) {
      jsonResponse(res, 413, route === '/chat'
        ? { schema: 'rapp-chat/1.0', status: 'error', error: 'Request body too large' }
        : { error: 'Request body too large' });
      return null;
    }
    return Buffer.concat(chunks);
  }

  private parseMultipartFile(
    contentType: string,
    raw: Buffer,
  ): { ok: true; filename: string; content: Buffer } | { ok: false; error: string } {
    if (!contentType.includes('multipart/form-data')) {
      return { ok: false, error: 'No file uploaded' };
    }
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!boundaryMatch) {
      return { ok: false, error: 'multipart/form-data requires a boundary' };
    }
    const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
    for (const part of raw.toString('binary').split(boundary.toString('binary'))) {
      const separator = part.indexOf('\r\n\r\n');
      if (separator < 0) continue;
      const headers = part.slice(0, separator);
      const filename = /filename="([^"]+)"/i.exec(headers)?.[1];
      if (!filename) continue;
      let body = Buffer.from(part.slice(separator + 4), 'binary');
      if (body.subarray(-2).toString() === '\r\n') body = body.subarray(0, -2);
      if (body.subarray(-2).toString() === '--') body = body.subarray(0, -2);
      return { ok: true, filename: path.basename(filename), content: body };
    }
    return { ok: false, error: 'Malformed multipart body' };
  }

  private async runIdempotent(
    key: string | undefined,
    fingerprint: string,
    runner: () => Promise<JsonObject>,
  ): Promise<JsonObject> {
    if (!key) return runner();
    const now = Date.now();
    for (const [entryKey, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(entryKey);
    }
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflict('Idempotency key conflicts with another request');
      }
      return { ...await existing.promise };
    }
    const promise = runner();
    this.idempotency.set(key, {
      fingerprint,
      expiresAt: now + 15 * 60 * 1000,
      promise,
    });
    if (this.idempotency.size > 512) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest) this.idempotency.delete(oldest);
    }
    try {
      return { ...await promise };
    } catch (error) {
      this.idempotency.delete(key);
      throw error;
    }
  }
}

class IdempotencyConflict extends Error {}

export async function serveBrainstem(options: BrainstemOptions = {}): Promise<BrainstemKernel> {
  const kernel = await new BrainstemKernel(options).start();
  const agents = await kernel.loadAgents();
  brainstemLog.info(`OpenRappter Brainstem v${VERSION} listening`, {
    url: `http://${kernel.host}:${kernel.port}`,
    agents: agents.size,
    agentsPath: kernel.agentsPath,
    soulPath: kernel.soulPath,
    model: kernel.model,
  });
  return kernel;
}

export async function main(): Promise<void> {
  await serveBrainstem();
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().catch(error => {
    brainstemLog.fatal('Brainstem failed to start', { error: errorMessage(error) });
    process.exitCode = 1;
  });
}

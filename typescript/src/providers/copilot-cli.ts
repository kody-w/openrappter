import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ProviderResponse,
} from './types.js';

export const COPILOT_CLI_DEFAULT_MODEL = 'gpt-5.6-sol';
export const COPILOT_CLI_DEFAULT_TIMEOUT_MS = 120_000;
export const COPILOT_CLI_MAX_TIMEOUT_MS = 180_000;
export const COPILOT_CLI_MAX_PROMPT_BYTES = 64 * 1024;

const COPILOT_CLI_MIN_TIMEOUT_MS = 1_000;
const COPILOT_CLI_DEFAULT_PROMPT_BYTES = 32 * 1024;
const COPILOT_CLI_MIN_PROMPT_BYTES = 1_024;
const COPILOT_CLI_MAX_OUTPUT_BYTES = 256 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const TOKEN_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;
const PROMPT_PREAMBLE = [
  'Continue this chat using only the conversation transcript JSON below.',
  'No tools are available.',
  'Return only the next assistant message, without a label, wrapper, or commentary.',
  'Transcript JSON:',
  '',
].join('\n');
const ATTACHMENT_PROMPT =
  'Follow the instructions and conversation transcript in the attached private document. Return only the next assistant message.';
const TRUNCATION_MARKER = '…[truncated]…';

export interface CopilotCliRunOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  shell: false;
  signal?: AbortSignal;
}

export interface CopilotCliRunResult {
  stdout: string;
  exitCode: number | null;
  timedOut?: boolean;
  stderr?: string;
}

export type CopilotCliRunner = (
  executable: string,
  args: readonly string[],
  options: CopilotCliRunOptions,
) => Promise<CopilotCliRunResult>;

export type CopilotCliHomePreparer = (
  copilotHome: string,
  mode: number,
) => Promise<void>;

export interface CopilotCliPromptAttachment {
  path: string;
  cleanup(): Promise<void>;
}

export type CopilotCliPromptAttachmentPreparer = (
  prompt: string,
  copilotHome: string,
) => Promise<CopilotCliPromptAttachment>;

export interface CopilotCliProviderOptions {
  executable?: string;
  copilotHome?: string;
  model?: string;
  timeoutMs?: number;
  maxPromptBytes?: number;
  env?: NodeJS.ProcessEnv;
  runner?: CopilotCliRunner;
  homePreparer?: CopilotCliHomePreparer;
  fallbackModels?: string[];
  promptTransport?: 'argv' | 'attachment';
  promptAttachmentPreparer?: CopilotCliPromptAttachmentPreparer;
}

interface TranscriptMessage {
  role: Message['role'];
  content: string;
}

interface IndexedTranscriptMessage {
  index: number;
  message: TranscriptMessage;
}

function boundInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function firstToken(
  env: NodeJS.ProcessEnv,
): { key: (typeof TOKEN_ENV_KEYS)[number]; value: string } | undefined {
  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key];
    if (value) return { key, value };
  }
  return undefined;
}

function buildChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  copilotHome: string,
  token: { key: (typeof TOKEN_ENV_KEYS)[number]; value: string },
): Record<string, string> {
  const childEnv: Record<string, string> = {
    HOME: sourceEnv.HOME || homedir(),
    PATH: sourceEnv.PATH || DEFAULT_PATH,
    COPILOT_HOME: copilotHome,
  };

  for (const key of ['TMPDIR', 'LANG'] as const) {
    const value = sourceEnv[key];
    if (value) childEnv[key] = value;
  }

  childEnv[token.key] = token.value;
  return childEnv;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateContent(content: string, maximumCharacters: number): string {
  const characters = Array.from(content);
  if (characters.length <= maximumCharacters) return content;
  if (maximumCharacters <= 0) return '';

  const marker = Array.from(TRUNCATION_MARKER);
  if (maximumCharacters <= marker.length) {
    return characters.slice(0, maximumCharacters).join('');
  }

  const remaining = maximumCharacters - marker.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return [
    ...characters.slice(0, headLength),
    ...marker,
    ...characters.slice(characters.length - tailLength),
  ].join('');
}

function serializeTranscript(entries: IndexedTranscriptMessage[]): string {
  return JSON.stringify(
    [...entries]
      .sort((left, right) => left.index - right.index)
      .map(entry => entry.message),
  );
}

function fitRequiredEntries(
  entries: IndexedTranscriptMessage[],
  maximumBytes: number,
): IndexedTranscriptMessage[] {
  const fitted = entries.map(entry => ({
    index: entry.index,
    message: { ...entry.message },
  }));

  while (byteLength(serializeTranscript(fitted)) > maximumBytes) {
    const candidate = fitted
      .map(entry => ({
        entry,
        characters: Array.from(entry.message.content).length,
      }))
      .sort((left, right) => right.characters - left.characters)[0];

    if (!candidate || candidate.characters === 0) {
      throw new Error('Copilot CLI prompt limit is too small');
    }

    const excess = byteLength(serializeTranscript(fitted)) - maximumBytes;
    const maximumCharacters = Math.max(
      0,
      candidate.characters - Math.max(1, excess + TRUNCATION_MARKER.length),
    );
    candidate.entry.message.content = truncateContent(
      candidate.entry.message.content,
      maximumCharacters,
    );
  }

  return fitted;
}

function buildTranscriptPrompt(
  messages: Message[],
  maximumPromptBytes: number,
): string {
  const transcriptBudget = maximumPromptBytes - byteLength(PROMPT_PREAMBLE);
  const firstSystemIndex = messages.findIndex(message => message.role === 'system');
  const ordered = messages.map(message => ({
    message: {
      role: message.role,
      content: message.content,
    },
  }));

  if (firstSystemIndex >= 0) {
    const [system] = ordered.splice(firstSystemIndex, 1);
    ordered.unshift(system);
  }

  const indexed = ordered.map((entry, index) => ({
    index,
    message: entry.message,
  }));
  const requiredIndexes = new Set<number>();
  if (firstSystemIndex >= 0) requiredIndexes.add(0);
  if (indexed.length > 0) requiredIndexes.add(indexed.length - 1);

  let selected = fitRequiredEntries(
    indexed.filter(entry => requiredIndexes.has(entry.index)),
    transcriptBudget,
  );

  for (let index = indexed.length - 2; index >= 0; index--) {
    if (requiredIndexes.has(index)) continue;
    const candidate = [...selected, indexed[index]];
    if (byteLength(serializeTranscript(candidate)) > transcriptBudget) break;
    selected = candidate;
  }

  const prompt = `${PROMPT_PREAMBLE}${serializeTranscript(selected)}`;
  if (byteLength(prompt) > maximumPromptBytes) {
    throw new Error('Copilot CLI prompt limit was exceeded');
  }
  return prompt;
}

const defaultRunner: CopilotCliRunner = (
  executable,
  args,
  options,
) => new Promise(resolve => {
  execFile(
    executable,
    [...args],
    {
      cwd: options.cwd,
      env: { ...options.env },
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: COPILOT_CLI_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: options.timeoutMs,
      signal: options.signal,
      windowsHide: true,
    },
    (error, stdout) => {
      resolve({
        stdout,
        exitCode: error
          ? typeof error.code === 'number'
            ? error.code
            : null
          : 0,
        timedOut: Boolean(error?.killed),
      });
    },
  );
});

const defaultHomePreparer: CopilotCliHomePreparer = async (
  copilotHome,
  mode,
) => {
  await mkdir(copilotHome, { recursive: true, mode });
  await chmod(copilotHome, mode);
  await prunePrivatePromptFiles(copilotHome);
};

async function removePrivatePromptFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function prunePrivatePromptFiles(directory: string): Promise<void> {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const names = await readdir(directory);
  await Promise.all(names
    .filter(name =>
      name.startsWith('.')
      && (
        name.endsWith('.prompt.txt')
        || name.endsWith('.prompt.docx')
      ),
    )
    .map(async name => {
      const filePath = path.join(directory, name);
      try {
        const ownerPid = Number(name.split('.')[1]);
        const abandoned =
          Number.isSafeInteger(ownerPid)
          && ownerPid !== process.pid
          && !processExists(ownerPid);
        if (abandoned || (await stat(filePath)).mtimeMs < cutoff) {
          await removePrivatePromptFile(filePath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
}

const defaultPromptAttachmentPreparer: CopilotCliPromptAttachmentPreparer =
  async (prompt, copilotHome) => {
    const identifier = `${process.pid}.${randomUUID()}`;
    const textPath = path.join(copilotHome, `.${identifier}.prompt.txt`);
    const documentPath = path.join(copilotHome, `.${identifier}.prompt.docx`);
    const cleanup = async (): Promise<void> => {
      await Promise.all([
        removePrivatePromptFile(textPath),
        removePrivatePromptFile(documentPath),
      ]);
    };

    try {
      await writeFile(textPath, prompt, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(textPath, 0o600);
      await new Promise<void>((resolve, reject) => {
        execFile(
          '/usr/bin/textutil',
          ['-convert', 'docx', '-output', documentPath, textPath],
          {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
          },
          error => error ? reject(error) : resolve(),
        );
      });
      await chmod(documentPath, 0o600);
      await removePrivatePromptFile(textPath);
      return { path: documentPath, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

export class CopilotCliProvider implements LLMProvider {
  readonly id = 'copilot-cli';
  readonly name = 'GitHub Copilot CLI';

  private readonly executable: string;
  private readonly copilotHome: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxPromptBytes: number;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly runner: CopilotCliRunner;
  private readonly homePreparer: CopilotCliHomePreparer;
  private readonly fallbackModels: string[];
  private readonly promptTransport: 'argv' | 'attachment';
  private readonly promptAttachmentPreparer: CopilotCliPromptAttachmentPreparer;

  constructor(options: CopilotCliProviderOptions = {}) {
    this.sourceEnv = { ...(options.env ?? process.env) };
    this.executable =
      options.executable?.trim()
      || this.sourceEnv.COPILOT_CLI_PATH?.trim()
      || 'copilot';
    this.copilotHome =
      options.copilotHome?.trim()
      || path.join(homedir(), '.openrappter', 'copilot-imessage-home');
    this.model = options.model?.trim() || COPILOT_CLI_DEFAULT_MODEL;
    this.timeoutMs = boundInteger(
      options.timeoutMs,
      COPILOT_CLI_DEFAULT_TIMEOUT_MS,
      COPILOT_CLI_MIN_TIMEOUT_MS,
      COPILOT_CLI_MAX_TIMEOUT_MS,
    );
    this.maxPromptBytes = boundInteger(
      options.maxPromptBytes,
      COPILOT_CLI_DEFAULT_PROMPT_BYTES,
      COPILOT_CLI_MIN_PROMPT_BYTES,
      COPILOT_CLI_MAX_PROMPT_BYTES,
    );
    this.runner = options.runner ?? defaultRunner;
    this.homePreparer = options.homePreparer ?? defaultHomePreparer;
    this.fallbackModels = Array.from(new Set(
      (options.fallbackModels ?? [])
        .filter(model => typeof model === 'string')
        .map(model => model.trim()),
    ));
    this.promptTransport = options.promptTransport ?? 'attachment';
    this.promptAttachmentPreparer =
      options.promptAttachmentPreparer ?? defaultPromptAttachmentPreparer;
  }

  updateToken(token: string): void {
    for (const key of TOKEN_ENV_KEYS) {
      delete this.sourceEnv[key];
    }
    const normalized = token.trim();
    if (normalized) {
      this.sourceEnv.COPILOT_GITHUB_TOKEN = normalized;
    }
  }

  async chat(
    messages: Message[],
    options?: ChatOptions,
  ): Promise<ProviderResponse> {
    const token = firstToken(this.sourceEnv);
    if (!token) {
      throw new Error('Copilot CLI token is not configured');
    }

    try {
      await this.homePreparer(this.copilotHome, PRIVATE_DIRECTORY_MODE);
    } catch {
      throw new Error('Copilot CLI home is unavailable');
    }

    const prompt = buildTranscriptPrompt(messages, this.maxPromptBytes);
    let attachment: CopilotCliPromptAttachment | undefined;
    if (this.promptTransport === 'attachment') {
      try {
        attachment = await this.promptAttachmentPreparer(
          prompt,
          this.copilotHome,
        );
      } catch {
        throw new Error('Copilot CLI private prompt attachment is unavailable');
      }
    }
    const promptArgument = attachment ? ATTACHMENT_PROMPT : prompt;
    const requestedModel = options?.model?.trim() || this.model;
    const modelCandidates = Array.from(new Set([
      requestedModel,
      ...this.fallbackModels,
    ]));
    let lastFailure = 'Copilot CLI request failed';

    try {
      for (const model of modelCandidates) {
        if (options?.signal?.aborted) {
          throw new Error('Copilot CLI request aborted');
        }
        const args = [
          '--prompt',
          promptArgument,
          ...(attachment ? ['--attachment', attachment.path] : []),
          '--silent',
          '--no-remote',
          '--no-remote-export',
          '--no-auto-update',
          '--no-custom-instructions',
          '--no-ask-user',
          ...(model ? ['--model', model] : []),
          '--effort',
          'max',
          '--available-tools=',
        ];

        let result: CopilotCliRunResult;
        try {
          result = await this.runner(this.executable, args, {
            cwd: this.copilotHome,
            env: buildChildEnv(this.sourceEnv, this.copilotHome, token),
            timeoutMs: this.timeoutMs,
            shell: false,
            signal: options?.signal,
          });
        } catch {
          if (options?.signal?.aborted) {
            throw new Error('Copilot CLI request aborted');
          }
          lastFailure = 'Copilot CLI request failed';
          continue;
        }

        if (options?.signal?.aborted) {
          throw new Error('Copilot CLI request aborted');
        }
        if (result.timedOut) {
          lastFailure = 'Copilot CLI request timed out';
          continue;
        }
        if (result.exitCode !== 0) {
          lastFailure = 'Copilot CLI request failed';
          continue;
        }

        const content = result.stdout.trim();
        if (!content) {
          lastFailure = 'Copilot CLI returned an empty response';
          continue;
        }
        return { content, tool_calls: null };
      }

      throw new Error(lastFailure);
    } finally {
      if (attachment) {
        try {
          await attachment.cleanup();
        } catch {
          throw new Error('Copilot CLI private prompt cleanup failed');
        }
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.executable && firstToken(this.sourceEnv));
  }
}

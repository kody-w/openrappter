/**
 * Type declarations for optional/dynamic dependencies
 * These modules are dynamically imported at runtime and may not be installed.
 */

declare module 'chokidar' {
  interface FSWatcher {
    on(event: string, callback: (...args: unknown[]) => void): FSWatcher;
    close(): void;
  }
  export function watch(path: string, options?: Record<string, unknown>): FSWatcher;
}

declare module 'node-edge-tts' {
  export class EdgeTTS {
    constructor(options?: {
      voice?: string;
      lang?: string;
      outputFormat?: string;
      saveSubtitles?: boolean;
      proxy?: string;
      rate?: string;
      pitch?: string;
      volume?: string;
      timeout?: number;
    });
    ttsPromise(text: string, outputPath: string): Promise<void>;
  }
}

declare module 'blessed' {
  function screen(options?: Record<string, unknown>): unknown;
  export = { screen };
}

declare module 'playwright-core' {
  export const chromium: {
    launch(options?: Record<string, unknown>): Promise<unknown>;
    connect(options?: Record<string, unknown>): Promise<unknown>;
  };
}

declare module 'matrix-js-sdk' {
  export function createClient(options: Record<string, unknown>): unknown;
}

declare module 'botbuilder' {
  export class BotFrameworkAdapter {
    constructor(options: Record<string, unknown>);
    processActivity(req: unknown, res: unknown, logic: (context: unknown) => Promise<void>): Promise<void>;
    continueConversation(reference: unknown, logic: (context: unknown) => Promise<void>): Promise<void>;
  }
}

declare module 'better-sqlite3' {
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
    pragma(pragma: string, options?: Record<string, unknown>): unknown;
  }
  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  function Database(filename: string, options?: Record<string, unknown>): Database;
  export default Database;
}

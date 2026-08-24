import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const NARRATION_MODEL_ID = 'Xenova/whisper-small';
export const NARRATION_MODEL_REVISION =
  '2d67713f236afa48a18992566e7647f6ca848e13';
export const NARRATION_MODEL_DOWNLOAD_LABEL = '~252 MB';
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  path.join('onnx', 'encoder_model_quantized.onnx'),
  path.join('onnx', 'decoder_model_merged_quantized.onnx'),
] as const;

export type NarrationOwner =
  | 'skills-recorder'
  | 'voice-conversation'
  | 'buddy-evidence'
  | 'desktop-smoke'
  | 'system';

export type NarrationHealth =
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'busy'
  | 'offline'
  | 'error'
  | 'stopped';

export interface NarrationStatus {
  model: 'missing' | 'downloading' | 'ready' | 'error';
  phase: 'idle' | 'loading' | 'transcribing';
  health: NarrationHealth;
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
  loaded: boolean;
  references: number;
  owners: Record<string, number>;
  queueDepth: number;
  activeRequestId: string | null;
  restartCount: number;
}

interface AsrResult {
  text?: string;
  chunks?: Array<{
    timestamp?: [number, number | null];
    text?: string;
  }>;
}

type AsrPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<AsrResult>;

interface PipelineFactoryContext {
  model: string;
  revision: string;
  cacheDir: string;
  allowDownload: boolean;
  progress: (progress: {
    progress?: number;
    loaded?: number;
    total?: number;
  }) => void;
}

export interface NarrationServiceOptions {
  cacheDir?: string;
  cacheReady?: () => boolean;
  markCacheReady?: () => void;
  pipelineFactory?: (
    context: PipelineFactoryContext,
  ) => Promise<AsrPipeline>;
  maxQueued?: number;
  maxResidentSamples?: number;
  idleUnloadMs?: number;
}

export interface NarrationTranscribeOptions {
  owner?: NarrationOwner;
  requestId?: string;
  maxSegmentSeconds?: number;
}

export interface NarrationTranscript {
  model: string;
  language: string;
  text: string;
  segments: Array<{ atMs: number; endMs: number; text: string }>;
}

interface TranscriptionJob {
  id: string;
  owner: NarrationOwner;
  samples: Float32Array;
  language: string;
  maxSegmentSeconds: number;
  cancelled: boolean;
  resolve: (value: NarrationTranscript) => void;
  reject: (error: Error) => void;
}

export class NarrationServiceError extends Error {
  constructor(
    readonly code:
      | 'cancelled'
      | 'queue_full'
      | 'duplicate_request'
      | 'stopped',
    message: string,
  ) {
    super(message);
    this.name = 'NarrationServiceError';
  }
}

const boilerplate = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'please subscribe',
  'bye',
]);

function meaningful(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return text.trim().length >= 2
    && /\p{L}/u.test(text)
    && !boilerplate.has(normalized);
}

function cancelledError(): NarrationServiceError {
  return new NarrationServiceError(
    'cancelled',
    'Local transcription was cancelled.',
  );
}

function safeOwner(value: NarrationOwner): NarrationOwner {
  const allowed: readonly NarrationOwner[] = [
    'skills-recorder',
    'voice-conversation',
    'buddy-evidence',
    'desktop-smoke',
    'system',
  ];
  return allowed.includes(value) ? value : 'system';
}

export class NarrationService {
  private pipe: AsrPipeline | null = null;
  private loading: Promise<AsrPipeline> | null = null;
  private current: NarrationStatus;
  private readonly queue: TranscriptionJob[] = [];
  private active: TranscriptionJob | null = null;
  private readonly owners = new Map<NarrationOwner, number>();
  private readonly maxQueued: number;
  private readonly maxResidentSamples: number;
  private readonly idleUnloadMs: number;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private lifecycleGeneration = 0;
  private requestCounter = 0;

  constructor(
    private readonly emit: (status: NarrationStatus) => void,
    private readonly options: NarrationServiceOptions = {},
  ) {
    this.maxQueued = options.maxQueued ?? 3;
    // One ten-minute Skills Recorder job plus two short Voice turns.
    this.maxResidentSamples = options.maxResidentSamples
      ?? 12 * 60 * 16_000;
    this.idleUnloadMs = options.idleUnloadMs ?? 60_000;
    const cached = this.isCached();
    this.current = {
      model: cached ? 'ready' : 'missing',
      phase: 'idle',
      health: cached ? 'ready' : 'missing',
      progress: null,
      loadedBytes: null,
      totalBytes: null,
      error: null,
      loaded: false,
      references: 0,
      owners: {},
      queueDepth: 0,
      activeRequestId: null,
      restartCount: 0,
    };
  }

  cacheDir(): string {
    return this.options.cacheDir
      ?? path.join(process.cwd(), '.openrappter-models');
  }

  isCached(): boolean {
    if (this.options.cacheReady) return this.options.cacheReady();
    const root = path.join(this.cacheDir(), ...NARRATION_MODEL_ID.split('/'));
    let revision = '';
    try {
      revision = readFileSync(
        path.join(root, 'openrappter-model.json'),
        'utf8',
      );
    } catch {
      return false;
    }
    return revision.trim() === NARRATION_MODEL_REVISION
      && MODEL_FILES.every((file) => existsSync(path.join(root, file)));
  }

  acquire(owner: NarrationOwner): NarrationStatus {
    this.assertRunning();
    const safe = safeOwner(owner);
    this.cancelIdleUnload();
    this.owners.set(safe, (this.owners.get(safe) ?? 0) + 1);
    this.publishLifecycle();
    return this.status();
  }

  release(owner: NarrationOwner): NarrationStatus {
    const safe = safeOwner(owner);
    const count = this.owners.get(safe) ?? 0;
    if (count <= 1) this.owners.delete(safe);
    else this.owners.set(safe, count - 1);
    this.publishLifecycle();
    this.scheduleIdleUnload();
    return this.status();
  }

  status(): NarrationStatus {
    return {
      ...this.current,
      owners: { ...this.current.owners },
    };
  }

  async download(owner: NarrationOwner = 'system'): Promise<NarrationStatus> {
    this.assertRunning();
    const temporary = !this.owners.has(owner);
    if (temporary) this.acquire(owner);
    try {
      await this.load(true);
      return this.status();
    } finally {
      if (temporary) this.release(owner);
    }
  }

  transcribe(
    samples: Float32Array,
    language = 'en',
    options: NarrationTranscribeOptions = {},
  ): Promise<NarrationTranscript> {
    if (this.stopped) {
      return Promise.reject(new NarrationServiceError(
        'stopped',
        'Local Whisper service is stopped.',
      ));
    }
    if (samples.length === 0) {
      return Promise.reject(new Error('Narration audio is empty.'));
    }
    if (samples.length > 10 * 60 * 16_000) {
      return Promise.reject(
        new Error('Narration audio exceeds the 10-minute local safety limit.'),
      );
    }
    const id = options.requestId
      ?? `narration-${Date.now()}-${++this.requestCounter}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      return Promise.reject(new Error('Invalid local transcription request id.'));
    }
    if (
      this.active?.id === id
      || this.queue.some((job) => job.id === id)
    ) {
      return Promise.reject(new NarrationServiceError(
        'duplicate_request',
        'Local transcription request id is already active.',
      ));
    }
    const residentSamples = (this.active?.samples.length ?? 0)
      + this.queue.reduce((total, job) => total + job.samples.length, 0);
    if (
      this.queue.length >= this.maxQueued
      || residentSamples + samples.length > this.maxResidentSamples
    ) {
      return Promise.reject(new NarrationServiceError(
        'queue_full',
        'Local transcription queue is full.',
      ));
    }
    const owner = safeOwner(options.owner ?? 'system');
    const temporary = !this.owners.has(owner);
    if (temporary) this.acquire(owner);
    return new Promise<NarrationTranscript>((resolve, reject) => {
      const settle = (
        callback: (value: NarrationTranscript) => void,
      ) => (value: NarrationTranscript) => {
        if (temporary) this.release(owner);
        callback(value);
      };
      const fail = (error: Error) => {
        if (temporary) this.release(owner);
        reject(error);
      };
      this.queue.push({
        id,
        owner,
        samples,
        language: /^[a-z]{2,3}$/i.test(language)
          ? language.toLowerCase()
          : 'en',
        maxSegmentSeconds: Math.min(
          30,
          Math.max(5, options.maxSegmentSeconds ?? 30),
        ),
        cancelled: false,
        resolve: settle(resolve),
        reject: fail,
      });
      this.publishQueue();
      this.pump();
    });
  }

  cancel(requestId: string): boolean {
    if (this.active?.id === requestId) {
      this.active.cancelled = true;
      return true;
    }
    const index = this.queue.findIndex((job) => job.id === requestId);
    if (index < 0) return false;
    const [job] = this.queue.splice(index, 1);
    job.cancelled = true;
    job.reject(cancelledError());
    this.publishQueue();
    this.scheduleIdleUnload();
    return true;
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycleGeneration += 1;
    this.cancelIdleUnload();
    this.pipe = null;
    this.loading = null;
    if (this.active) this.active.cancelled = true;
    for (const job of this.queue.splice(0)) {
      job.cancelled = true;
      job.reject(cancelledError());
    }
    this.owners.clear();
    this.update({
      model: this.isCached() ? 'ready' : 'missing',
      phase: 'idle',
      health: 'stopped',
      loaded: false,
      references: 0,
      owners: {},
      queueDepth: 0,
      error: null,
    });
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const job = this.queue.shift();
    if (!job) {
      this.publishQueue();
      this.scheduleIdleUnload();
      return;
    }
    this.active = job;
    this.update({
      phase: 'transcribing',
      health: 'busy',
      activeRequestId: job.id,
      queueDepth: this.queue.length,
      error: null,
    });
    let failedHealth: NarrationHealth | null = null;
    void this.run(job).then(
      (value) => {
        if (job.cancelled || this.stopped) job.reject(cancelledError());
        else job.resolve(value);
      },
      (error: unknown) => {
        if (!job.cancelled && !this.stopped) {
          const message = error instanceof Error ? error.message : String(error);
          failedHealth = /not been downloaded/i.test(message)
            ? 'missing'
            : error instanceof TypeError
              || (error && typeof error === 'object' && 'code' in error
                && error.code === 'offline')
              ? 'offline'
              : 'error';
          this.update({
            health: failedHealth,
            error: message,
          });
        }
        job.reject(
          job.cancelled || this.stopped
            ? cancelledError()
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
      },
    ).finally(() => {
      if (this.active === job) this.active = null;
      if (!this.stopped) {
        this.update({
          phase: 'idle',
          health: failedHealth ?? (this.isCached() ? 'ready' : 'missing'),
          activeRequestId: null,
          queueDepth: this.queue.length,
        });
        this.pump();
      }
    });
  }

  private async run(job: TranscriptionJob): Promise<NarrationTranscript> {
    let pipe = await this.load(false);
    let result: AsrResult;
    try {
      result = await this.invoke(pipe, job);
    } catch (error) {
      if (job.cancelled || this.stopped) throw cancelledError();
      this.pipe = null;
      this.current.restartCount += 1;
      this.update({
        phase: 'loading',
        health: 'error',
        loaded: false,
        error: 'Local Whisper stopped unexpectedly; restarting.',
      });
      pipe = await this.load(false);
      result = await this.invoke(pipe, job);
    }
    if (job.cancelled || this.stopped) throw cancelledError();
    return this.toTranscript(result, job.samples.length, job.language);
  }

  private invoke(
    pipe: AsrPipeline,
    job: TranscriptionJob,
  ): Promise<AsrResult> {
    return pipe(job.samples, {
      return_timestamps: true,
      chunk_length_s: job.maxSegmentSeconds,
      stride_length_s: Math.min(5, job.maxSegmentSeconds / 3),
      language: job.language,
      task: 'transcribe',
      request_id: job.id,
    });
  }

  private toTranscript(
    result: AsrResult,
    sampleCount: number,
    language: string,
  ): NarrationTranscript {
    const duration = sampleCount / 16_000;
    const chunks = result.chunks?.length
      ? result.chunks.slice(0, 256)
      : [{
          timestamp: [0, duration] as [number, number],
          text: result.text ?? '',
        }];
    const segments = chunks.flatMap((chunk) => {
      const spoken = (chunk.text ?? '').trim().slice(0, 4_000);
      if (!meaningful(spoken)) return [];
      const start = Math.max(0, chunk.timestamp?.[0] ?? 0);
      const rawEnd = chunk.timestamp?.[1] ?? Math.min(duration, start + 2);
      const end = Math.max(start, Math.min(duration, rawEnd));
      return [{
        atMs: Math.round(start * 1_000),
        endMs: Math.round(end * 1_000),
        text: spoken,
      }];
    });
    return {
      model: NARRATION_MODEL_ID,
      language,
      text: segments.map((segment) => segment.text).join(' ').trim()
        .slice(0, 50_000),
      segments,
    };
  }

  private async load(allowDownload: boolean): Promise<AsrPipeline> {
    this.assertRunning();
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    if (!allowDownload && !this.isCached()) {
      throw new Error('The local Whisper model has not been downloaded yet.');
    }
    const generation = this.lifecycleGeneration;
    this.update({
      model: allowDownload ? 'downloading' : this.current.model,
      phase: 'loading',
      health: allowDownload ? 'downloading' : this.current.health,
      progress: null,
      loadedBytes: null,
      totalBytes: null,
      error: null,
    });
    this.loading = this.build(allowDownload);
    try {
      const pipe = await this.loading;
      if (this.stopped || generation !== this.lifecycleGeneration) {
        throw new NarrationServiceError('stopped', 'Local Whisper service is stopped.');
      }
      this.pipe = pipe;
      this.markCached();
      this.update({
        model: 'ready',
        phase: 'idle',
        health: 'ready',
        progress: 100,
        loaded: true,
        error: null,
      });
      return pipe;
    } catch (error) {
      const offline = error instanceof TypeError
        || (error && typeof error === 'object' && 'code' in error
          && error.code === 'offline');
      this.update({
        model: this.isCached() ? 'ready' : 'error',
        phase: 'idle',
        health: offline ? 'offline' : this.stopped ? 'stopped' : 'error',
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.loading = null;
    }
  }

  private async build(allowDownload: boolean): Promise<AsrPipeline> {
    const progress = (value: {
      progress?: number;
      loaded?: number;
      total?: number;
    }) => {
      this.update({
        progress:
          typeof value.progress === 'number'
            ? Math.max(0, Math.min(100, value.progress))
            : this.current.progress,
        loadedBytes:
          typeof value.loaded === 'number'
            ? value.loaded
            : this.current.loadedBytes,
        totalBytes:
          typeof value.total === 'number'
            ? value.total
            : this.current.totalBytes,
      });
    };
    if (this.options.pipelineFactory) {
      return this.options.pipelineFactory({
        model: NARRATION_MODEL_ID,
        revision: NARRATION_MODEL_REVISION,
        cacheDir: this.cacheDir(),
        allowDownload,
        progress,
      });
    }
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = this.cacheDir();
    const pipe = await tf.pipeline(
      'automatic-speech-recognition',
      NARRATION_MODEL_ID,
      {
        dtype: 'q8',
        revision: NARRATION_MODEL_REVISION,
        local_files_only: !allowDownload,
        progress_callback: progress,
        session_options: { enableCpuMemArena: false },
      } as never,
    );
    return pipe as unknown as AsrPipeline;
  }

  private markCached(): void {
    if (this.options.markCacheReady) {
      this.options.markCacheReady();
      return;
    }
    const modelRoot = path.join(
      this.cacheDir(),
      ...NARRATION_MODEL_ID.split('/'),
    );
    writeFileSync(
      path.join(modelRoot, 'openrappter-model.json'),
      `${NARRATION_MODEL_REVISION}\n`,
      { mode: 0o600 },
    );
  }

  private references(): number {
    return [...this.owners.values()].reduce((total, value) => total + value, 0);
  }

  private publishLifecycle(): void {
    this.update({
      references: this.references(),
      owners: Object.fromEntries(this.owners),
    });
  }

  private publishQueue(): void {
    this.update({
      queueDepth: this.queue.length,
      activeRequestId: this.active?.id ?? null,
    });
  }

  private scheduleIdleUnload(): void {
    if (
      this.references() > 0
      || this.active
      || this.queue.length > 0
      || !this.pipe
      || this.stopped
    ) {
      return;
    }
    this.cancelIdleUnload();
    if (this.idleUnloadMs <= 0) {
      this.unload();
      return;
    }
    this.idleTimer = setTimeout(() => this.unload(), this.idleUnloadMs);
  }

  private cancelIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private unload(): void {
    if (this.references() > 0 || this.active || this.queue.length > 0) return;
    this.pipe = null;
    this.update({
      loaded: false,
      phase: 'idle',
      health: this.isCached() ? 'ready' : 'missing',
    });
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new NarrationServiceError(
        'stopped',
        'Local Whisper service is stopped.',
      );
    }
  }

  private update(patch: Partial<NarrationStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit(this.status());
  }
}

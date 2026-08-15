import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

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

export interface NarrationStatus {
  model: 'missing' | 'downloading' | 'ready' | 'error';
  phase: 'idle' | 'loading' | 'transcribing';
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
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
  return text.trim().length >= 2 &&
    /\p{L}/u.test(text) &&
    !boilerplate.has(normalized);
}

export class NarrationService {
  private pipe: AsrPipeline | null = null;
  private loading: Promise<AsrPipeline> | null = null;
  private current: NarrationStatus;

  constructor(
    private readonly emit: (status: NarrationStatus) => void,
  ) {
    this.current = {
      model: this.isCached() ? 'ready' : 'missing',
      phase: 'idle',
      progress: null,
      loadedBytes: null,
      totalBytes: null,
      error: null,
    };
  }

  cacheDir(): string {
    return path.join(app.getPath('userData'), 'models');
  }

  isCached(): boolean {
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
    return revision.trim() === NARRATION_MODEL_REVISION &&
      MODEL_FILES.every((file) => existsSync(path.join(root, file)));
  }

  status(): NarrationStatus {
    return { ...this.current };
  }

  async download(): Promise<NarrationStatus> {
    await this.load(true);
    return this.status();
  }

  async transcribe(
    samples: Float32Array,
    language = 'en',
  ): Promise<{
    model: string;
    language: string;
    text: string;
    segments: Array<{ atMs: number; endMs: number; text: string }>;
  }> {
    if (samples.length === 0) throw new Error('Narration audio is empty.');
    const pipe = await this.load(false);
    this.update({ phase: 'transcribing', error: null });
    try {
      const result = await pipe(samples, {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        language,
        task: 'transcribe',
      });
      const duration = samples.length / 16_000;
      const chunks = result.chunks?.length
        ? result.chunks
        : [{
            timestamp: [0, duration] as [number, number],
            text: result.text ?? '',
          }];
      const segments = chunks.flatMap((chunk) => {
        const spoken = (chunk.text ?? '').trim();
        if (!meaningful(spoken)) return [];
        const start = chunk.timestamp?.[0] ?? 0;
        const end = chunk.timestamp?.[1] ?? Math.min(duration, start + 2);
        return [{
          atMs: Math.max(0, Math.round(start * 1000)),
          endMs: Math.max(0, Math.round(end * 1000)),
          text: spoken,
        }];
      });
      return {
        model: NARRATION_MODEL_ID,
        language,
        text: segments.map((segment) => segment.text).join(' ').trim(),
        segments,
      };
    } finally {
      this.update({ phase: 'idle' });
    }
  }

  private async load(allowDownload: boolean): Promise<AsrPipeline> {
    if (this.pipe) return this.pipe;
    if (!allowDownload && !this.isCached()) {
      throw new Error('The local Whisper model has not been downloaded yet.');
    }
    if (this.loading) return this.loading;
    this.update({
      model: allowDownload ? 'downloading' : this.current.model,
      phase: 'loading',
      progress: null,
      loadedBytes: null,
      totalBytes: null,
      error: null,
    });
    this.loading = this.build(allowDownload);
    try {
      this.pipe = await this.loading;
      const modelRoot = path.join(
        this.cacheDir(),
        ...NARRATION_MODEL_ID.split('/'),
      );
      writeFileSync(
        path.join(modelRoot, 'openrappter-model.json'),
        `${NARRATION_MODEL_REVISION}\n`,
        { mode: 0o600 },
      );
      this.update({
        model: 'ready',
        phase: 'idle',
        progress: 100,
        error: null,
      });
      return this.pipe;
    } catch (error) {
      this.update({
        model: this.isCached() ? 'ready' : 'error',
        phase: 'idle',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.loading = null;
    }
  }

  private async build(allowDownload: boolean): Promise<AsrPipeline> {
    const tf = await import('@huggingface/transformers');
    tf.env.cacheDir = this.cacheDir();
    const pipe = await tf.pipeline(
      'automatic-speech-recognition',
      NARRATION_MODEL_ID,
      {
        dtype: 'q8',
        revision: NARRATION_MODEL_REVISION,
        local_files_only: !allowDownload,
        progress_callback: (progress: {
          progress?: number;
          loaded?: number;
          total?: number;
        }) => {
          this.update({
            progress:
              typeof progress.progress === 'number'
                ? Math.max(0, Math.min(100, progress.progress))
                : this.current.progress,
            loadedBytes:
              typeof progress.loaded === 'number'
                ? progress.loaded
                : this.current.loadedBytes,
            totalBytes:
              typeof progress.total === 'number'
                ? progress.total
                : this.current.totalBytes,
          });
        },
        session_options: { enableCpuMemArena: false },
      } as never,
    );
    return pipe as unknown as AsrPipeline;
  }

  private update(patch: Partial<NarrationStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit(this.status());
  }
}

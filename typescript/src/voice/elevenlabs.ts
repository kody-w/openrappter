import { createHash } from 'node:crypto';

export const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io';
const API_PREFIX = '/v1';
const AUDIO_FORMAT = 'mp3_44100_128';
const AUDIO_BYTES_PER_SECOND = 16_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const API_KEY_PATTERN = /^(?:sk[_-])?[A-Za-z0-9_-]{20,200}$/;
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
]);

export type ElevenLabsErrorCode =
  | 'invalid_key'
  | 'insufficient_quota'
  | 'no_entitlement'
  | 'voice_unavailable'
  | 'model_unavailable'
  | 'offline'
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'text_too_long'
  | 'malformed_audio'
  | 'audio_too_large';

const SAFE_MESSAGES: Record<ElevenLabsErrorCode, string> = {
  invalid_key: 'The ElevenLabs credential is invalid.',
  insufficient_quota: 'The ElevenLabs account has insufficient character quota.',
  no_entitlement: 'The ElevenLabs account is not entitled to this operation.',
  voice_unavailable: 'The selected ElevenLabs voice is unavailable.',
  model_unavailable: 'The selected ElevenLabs model is unavailable.',
  offline: 'ElevenLabs is unreachable while this device is offline.',
  rate_limit: 'ElevenLabs rate limit reached. Try again later.',
  server_error: 'ElevenLabs is temporarily unavailable.',
  timeout: 'The ElevenLabs request timed out.',
  cancelled: 'Voice generation was cancelled.',
  busy: 'Another ElevenLabs voice request is already active.',
  text_too_long: 'The selected speech text exceeds the configured voice limit.',
  malformed_audio: 'ElevenLabs returned an unsupported audio response.',
  audio_too_large: 'ElevenLabs returned audio beyond the configured size or duration limit.',
};

export class ElevenLabsError extends Error {
  constructor(
    readonly code: ElevenLabsErrorCode,
    readonly retryable = false,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ElevenLabsError';
  }
}

export interface ElevenLabsVoice {
  id: string;
  name: string;
  language: string;
}

export interface ElevenLabsModel {
  id: string;
  name: string;
  languages: string[];
}

export interface ElevenLabsCatalog {
  voices: ElevenLabsVoice[];
  models: ElevenLabsModel[];
  verifiedAt: string;
}

export interface ElevenLabsVerification {
  catalog: ElevenLabsCatalog;
  quota: {
    usedCharacters: number | null;
    limitCharacters: number | null;
  };
}

export interface ElevenLabsSynthesisOptions {
  voice: string;
  model: string;
  signal?: AbortSignal;
}

export interface ElevenLabsSynthesis {
  audio: Buffer;
  mimeType: string;
  voice: string;
  model: string;
  characters: number;
  durationSeconds: number;
  sha256: string;
}

export interface ElevenLabsClientOptions {
  getApiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTextCharacters?: number;
  maxAudioBytes?: number;
  maxEstimatedDurationSeconds?: number;
  maxConcurrent?: number;
  maxRequestsPerMinute?: number;
  maxCharactersPerDay?: number;
  catalogTtlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  signal?: AbortSignal;
  body?: Record<string, unknown>;
  audio?: boolean;
  retrySafe?: boolean;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validateId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return cleaned || fallback;
}

function mapHttpError(response: Response): ElevenLabsError {
  const status = response.status;
  if (status === 401) return new ElevenLabsError('invalid_key');
  if (status === 402) return new ElevenLabsError('insufficient_quota');
  if (status === 403) return new ElevenLabsError('no_entitlement');
  if (status === 404 || status === 422) return new ElevenLabsError('voice_unavailable');
  if (status === 429) {
    const providerCode = response.headers.get('x-elevenlabs-error-code')?.toLowerCase();
    return new ElevenLabsError(
      providerCode === 'quota_exceeded' ? 'insufficient_quota' : 'rate_limit',
      providerCode !== 'quota_exceeded',
    );
  }
  return new ElevenLabsError('server_error', status >= 500);
}

export class ElevenLabsClient {
  private readonly getApiKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxTextCharacters: number;
  private readonly maxAudioBytes: number;
  private readonly maxEstimatedDurationSeconds: number;
  private readonly maxConcurrent: number;
  private readonly maxRequestsPerMinute: number;
  private readonly maxCharactersPerDay: number;
  private readonly catalogTtlMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private requestTimes: number[] = [];
  private characterDay = '';
  private characterCount = 0;
  private catalog: ElevenLabsCatalog | null = null;

  constructor(options: ElevenLabsClientOptions) {
    this.getApiKey = options.getApiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxTextCharacters = options.maxTextCharacters ?? 2_500;
    this.maxAudioBytes = options.maxAudioBytes ?? 8 * 1024 * 1024;
    this.maxEstimatedDurationSeconds = options.maxEstimatedDurationSeconds ?? 90;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 10;
    this.maxCharactersPerDay = options.maxCharactersPerDay ?? 20_000;
    this.catalogTtlMs = options.catalogTtlMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  primeCatalog(catalog: ElevenLabsCatalog): void {
    this.catalog = {
      voices: catalog.voices.map((voice) => ({ ...voice })),
      models: catalog.models.map((model) => ({ ...model, languages: [...model.languages] })),
      verifiedAt: catalog.verifiedAt,
    };
  }

  clearCatalog(): void {
    this.catalog = null;
  }

  async verify(signal?: AbortSignal): Promise<ElevenLabsVerification> {
    const subscription = await this.requestJson('/v1/user/subscription', signal);
    const voices = await this.listVoices(signal, true);
    const models = await this.listModels(signal, true);
    const verifiedAt = this.now().toISOString();
    this.catalog = { voices, models, verifiedAt };
    const data = subscription as Record<string, unknown>;
    return {
      catalog: this.catalog,
      quota: {
        usedCharacters: finiteNonNegative(data.character_count),
        limitCharacters: finiteNonNegative(data.character_limit),
      },
    };
  }

  async listVoices(signal?: AbortSignal, force = false): Promise<ElevenLabsVoice[]> {
    if (!force && this.catalogIsFresh()) return this.catalog!.voices.map((voice) => ({ ...voice }));
    const data = await this.requestJson('/v1/voices', signal) as { voices?: unknown[] };
    const voices = Array.isArray(data.voices)
      ? data.voices.flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const candidate = raw as Record<string, unknown>;
          const id = typeof candidate.voice_id === 'string' ? candidate.voice_id : '';
          if (!validateId(id)) return [];
          const labels = candidate.labels && typeof candidate.labels === 'object'
            ? candidate.labels as Record<string, unknown>
            : {};
          return [{
            id,
            name: safeName(candidate.name, id),
            language: safeName(labels.language, 'en').slice(0, 16),
          }];
        })
      : [];
    if (!force) {
      this.catalog = {
        voices,
        models: this.catalog?.models ?? [],
        verifiedAt: this.now().toISOString(),
      };
    }
    return voices;
  }

  async listModels(signal?: AbortSignal, force = false): Promise<ElevenLabsModel[]> {
    if (!force && this.catalogIsFresh()) return this.catalog!.models.map((model) => ({
      ...model,
      languages: [...model.languages],
    }));
    const data = await this.requestJson('/v1/models', signal);
    const models = Array.isArray(data)
      ? data.flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const candidate = raw as Record<string, unknown>;
          if (candidate.can_do_text_to_speech !== true) return [];
          const id = typeof candidate.model_id === 'string' ? candidate.model_id : '';
          if (!validateId(id)) return [];
          const languages = Array.isArray(candidate.languages)
            ? candidate.languages.flatMap((language) => {
                if (!language || typeof language !== 'object') return [];
                const value = (language as Record<string, unknown>).language_id;
                return typeof value === 'string' && /^[A-Za-z-]{2,16}$/.test(value)
                  ? [value]
                  : [];
              })
            : [];
          return [{
            id,
            name: safeName(candidate.name, id),
            languages,
          }];
        })
      : [];
    if (!force) {
      this.catalog = {
        voices: this.catalog?.voices ?? [],
        models,
        verifiedAt: this.now().toISOString(),
      };
    }
    return models;
  }

  async synthesize(
    text: string,
    options: ElevenLabsSynthesisOptions,
  ): Promise<ElevenLabsSynthesis> {
    const selectedText = text.trim();
    if (
      !selectedText
      || selectedText.length > this.maxTextCharacters
      || selectedText.length / 12 > this.maxEstimatedDurationSeconds
    ) {
      throw new ElevenLabsError('text_too_long');
    }
    if (
      !validateId(options.voice)
      || !this.catalog?.voices.some((voice) => voice.id === options.voice)
    ) {
      throw new ElevenLabsError('voice_unavailable');
    }
    if (
      !validateId(options.model)
      || !this.catalog?.models.some((model) => model.id === options.model)
    ) {
      throw new ElevenLabsError('model_unavailable');
    }

    this.reserve(selectedText.length);
    try {
      const path = `${API_PREFIX}/text-to-speech/${options.voice}/stream?output_format=${AUDIO_FORMAT}`;
      const response = await this.request({
        method: 'POST',
        path,
        signal: options.signal,
        audio: true,
        body: {
          text: selectedText,
          model_id: options.model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        },
      });
      const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      if (!AUDIO_TYPES.has(mimeType)) throw new ElevenLabsError('malformed_audio');
      const audio = await this.readBoundedAudio(response, options.signal);
      const durationSeconds = Number((audio.byteLength / AUDIO_BYTES_PER_SECOND).toFixed(3));
      if (durationSeconds > this.maxEstimatedDurationSeconds) {
        throw new ElevenLabsError('audio_too_large');
      }
      return {
        audio,
        mimeType,
        voice: options.voice,
        model: options.model,
        characters: selectedText.length,
        durationSeconds,
        sha256: createHash('sha256').update(audio).digest('hex'),
      };
    } finally {
      this.active -= 1;
    }
  }

  private catalogIsFresh(): boolean {
    if (!this.catalog) return false;
    const verified = Date.parse(this.catalog.verifiedAt);
    return Number.isFinite(verified) && this.now().getTime() - verified <= this.catalogTtlMs;
  }

  private reserve(characters: number): void {
    if (this.active >= this.maxConcurrent) throw new ElevenLabsError('busy', true);
    const now = this.now();
    const timestamp = now.getTime();
    this.requestTimes = this.requestTimes.filter((time) => timestamp - time < 60_000);
    if (this.requestTimes.length >= this.maxRequestsPerMinute) {
      throw new ElevenLabsError('rate_limit', true);
    }
    const day = now.toISOString().slice(0, 10);
    if (this.characterDay !== day) {
      this.characterDay = day;
      this.characterCount = 0;
    }
    if (this.characterCount + characters > this.maxCharactersPerDay) {
      throw new ElevenLabsError('insufficient_quota');
    }
    this.active += 1;
    this.requestTimes.push(timestamp);
    this.characterCount += characters;
  }

  private async requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request({
      method: 'GET',
      path,
      signal,
      retrySafe: true,
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw new ElevenLabsError('server_error');
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > 1024 * 1024) throw new ElevenLabsError('server_error');
    try {
      return await response.json();
    } catch {
      throw new ElevenLabsError('server_error');
    }
  }

  private async request(options: RequestOptions): Promise<Response> {
    this.assertAllowedPath(options.path, options.method);
    if (options.signal?.aborted) throw new ElevenLabsError('cancelled');
    const apiKey = await this.getApiKey();
    if (!apiKey || !API_KEY_PATTERN.test(apiKey)) throw new ElevenLabsError('invalid_key');

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const cancel = () => controller.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) {
        controller.abort();
        throw new ElevenLabsError('cancelled');
      }
      try {
        const response = await this.fetchImpl(`${ELEVENLABS_ORIGIN}${options.path}`, {
          method: options.method,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            Accept: options.audio ? 'audio/mpeg' : 'application/json',
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (response.ok) return response;
        const error = mapHttpError(response);
        if (options.retrySafe && error.retryable && attempt < 1) {
          attempt += 1;
          await response.body?.cancel();
          await this.sleep(100);
          continue;
        }
        if (options.retrySafe && response.status >= 500 && attempt < 1) {
          attempt += 1;
          await response.body?.cancel();
          await this.sleep(100);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof ElevenLabsError) throw error;
        if (options.signal?.aborted) throw new ElevenLabsError('cancelled');
        if (timedOut) throw new ElevenLabsError('timeout', true);
        if ((error as Error)?.name === 'AbortError') throw new ElevenLabsError('cancelled');
        throw new ElevenLabsError('offline', true);
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
      }
    }
  }

  private assertAllowedPath(path: string, method: 'GET' | 'POST'): void {
    const allowedGet = new Set([
      '/v1/user/subscription',
      '/v1/voices',
      '/v1/models',
    ]);
    if (method === 'GET' && allowedGet.has(path)) return;
    if (
      method === 'POST'
      && /^\/v1\/text-to-speech\/[A-Za-z0-9][A-Za-z0-9_-]{1,127}\/stream\?output_format=mp3_44100_128$/.test(path)
    ) {
      return;
    }
    throw new ElevenLabsError('server_error');
  }

  private async readBoundedAudio(response: Response, signal?: AbortSignal): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > this.maxAudioBytes) throw new ElevenLabsError('audio_too_large');
    if (!response.body) throw new ElevenLabsError('malformed_audio');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + this.timeoutMs;
    try {
      for (;;) {
        if (signal?.aborted) throw new ElevenLabsError('cancelled');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ElevenLabsError('timeout', true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedRead = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ElevenLabsError('timeout', true)),
            remaining,
          );
        });
        const { done, value } = await Promise.race([reader.read(), timedRead])
          .finally(() => clearTimeout(timer));
        if (done) break;
        total += value.byteLength;
        if (total > this.maxAudioBytes) {
          await reader.cancel();
          throw new ElevenLabsError('audio_too_large');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ElevenLabsError) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      if (signal?.aborted) throw new ElevenLabsError('cancelled');
      throw new ElevenLabsError('offline', true);
    }
    if (total === 0) throw new ElevenLabsError('malformed_audio');
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  }
}

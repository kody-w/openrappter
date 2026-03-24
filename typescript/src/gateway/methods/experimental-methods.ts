/**
 * Experimental features RPC methods.
 *
 * ⚠️  These methods control experimental features that are subject to change.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { experimentalConfigSchema, experimentalFeatureDescriptions } from '../../config/sections/experimental.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

const CONFIG_PATH = path.join(os.homedir(), '.openrappter', 'experimental.json');

function loadExperimentalConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveExperimentalConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function registerExperimentalMethods(server: MethodRegistrar, _deps?: Record<string, unknown>): void {
  /**
   * List all experimental features with their current status
   */
  server.registerMethod('experimental.list', async () => {
    const config = loadExperimentalConfig();
    const parsed = experimentalConfigSchema.safeParse(config);
    const current = parsed.success ? parsed.data : experimentalConfigSchema.parse({});

    return {
      disclaimer: 'EXPERIMENTAL: These features are subject to change, may be unstable, and could be removed. Use at your own risk.',
      masterEnabled: current.enabled,
      features: Object.entries(experimentalFeatureDescriptions).map(([key, meta]) => ({
        key,
        ...meta,
        enabled: current.enabled && (current as Record<string, any>)[key]?.enabled === true,
        config: (current as Record<string, any>)[key] ?? {},
      })),
    };
  });

  /**
   * Toggle an experimental feature on/off
   */
  server.registerMethod<{ feature: string; enabled: boolean }>(
    'experimental.toggle',
    async (params) => {
      const config = loadExperimentalConfig() as Record<string, any>;

      if (params.feature === 'master') {
        config.enabled = params.enabled;
      } else {
        if (!config[params.feature]) config[params.feature] = {};
        config[params.feature].enabled = params.enabled;
      }

      saveExperimentalConfig(config);

      return {
        feature: params.feature,
        enabled: params.enabled,
        disclaimer: 'Changes take effect immediately. Feature stability is not guaranteed.',
      };
    }
  );

  /**
   * Get/update experimental feature config
   */
  server.registerMethod<{ feature: string; config?: Record<string, unknown> }>(
    'experimental.config',
    async (params) => {
      const config = loadExperimentalConfig() as Record<string, any>;

      if (params.config) {
        // Update config
        config[params.feature] = { ...config[params.feature], ...params.config };
        saveExperimentalConfig(config);
      }

      return {
        feature: params.feature,
        config: config[params.feature] ?? {},
      };
    }
  );

  /**
   * Voice mode status
   */
  server.registerMethod('voice.mode.status', async () => {
    const config = loadExperimentalConfig() as Record<string, any>;
    const voiceMode = config.voiceMode ?? {};

    return {
      enabled: config.enabled === true && voiceMode.enabled === true,
      engine: voiceMode.engine ?? 'whisper',
      modelSize: voiceMode.modelSize ?? 'base',
      vad: voiceMode.vad ?? true,
      repetitionDetection: voiceMode.repetitionDetection ?? true,
      vipAnswerMode: voiceMode.vipAnswerMode ?? true,
      disclaimer: 'EXPERIMENTAL: Local voice mode requires whisper.cpp or vosk installed on your system.',
    };
  });

  /**
   * Transcribe audio using local STT engine
   */
  server.registerMethod<{ audio: string; format?: string }>(
    'voice.transcribe',
    async (params) => {
      const config = loadExperimentalConfig() as Record<string, any>;
      if (!config.enabled || !config.voiceMode?.enabled) {
        throw new Error('Voice mode is not enabled. Enable via experimental.toggle({ feature: "voiceMode", enabled: true })');
      }

      // Decode base64 audio
      const audioBuffer = Buffer.from(params.audio, 'base64');

      const { createTranscriptionService } = await import('../../voice/transcription.js');
      const service = createTranscriptionService({
        localWhisperPath: config.voiceMode?.execPath,
      });

      const result = await service.transcribe(audioBuffer, {
        language: config.voiceMode?.language,
      });

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        segments: result.segments,
      };
    }
  );
}

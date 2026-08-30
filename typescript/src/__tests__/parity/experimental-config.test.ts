/**
 * Tests for experimental features config schema and descriptions.
 */

import { describe, it, expect } from 'vitest';
import {
  experimentalConfigSchema,
  experimentalFeatureDescriptions,
} from '../../config/sections/experimental.js';
import {
  FEATURE_PROMOTION_ORDER,
  FEATURE_RELEASE_METADATA,
  FEATURE_RING_ORDER,
  getEffectiveFeatures,
  getFeatureReleaseMatrix,
} from '../../config/features.js';
import { validateConfig } from '../../config/schema.js';

describe('experimentalConfigSchema', () => {
  it('parses empty object with defaults', () => {
    const result = experimentalConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.harnessAdapters).toEqual({
      enabled: false,
      hermes: false,
      pi: false,
    });
    expect(result.brainSurgeonGroupChat).toEqual({ enabled: false });
    expect(result.voiceMode.enabled).toBe(false);
    expect(result.voiceMode.engine).toBe('whisper');
    expect(result.voiceMode.modelSize).toBe('base');
    expect(result.voiceMode.vad).toBe(true);
    expect(result.voiceMode.vadThreshold).toBe(0.5);
    expect(result.voiceMode.saveAudioBetweenTurns).toBe(true);
    expect(result.voiceMode.repetitionDetection).toBe(true);
    expect(result.voiceMode.repetitionThreshold).toBe(0.7);
    expect(result.voiceMode.vipAnswerMode).toBe(true);
    expect(result.tuiBar.enabled).toBe(false);
    expect(result.tuiBar.refreshInterval).toBe(2000);
  });

  it('accepts full config', () => {
    const result = experimentalConfigSchema.parse({
      enabled: true,
      harnessAdapters: {
        enabled: true,
        hermes: true,
        pi: true,
      },
      brainSurgeonGroupChat: {
        enabled: true,
      },
      voiceMode: {
        enabled: true,
        engine: 'vosk',
        modelPath: '/path/to/model',
        execPath: '/usr/local/bin/vosk',
        modelSize: 'small',
        vad: false,
        vadThreshold: 0.8,
        saveAudioBetweenTurns: false,
        repetitionDetection: false,
        repetitionThreshold: 0.5,
        vipAnswerMode: false,
      },
      tuiBar: {
        enabled: true,
        refreshInterval: 5000,
        showAgents: false,
        showExperimentalPanel: false,
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.harnessAdapters).toEqual({
      enabled: true,
      hermes: true,
      pi: true,
    });
    expect(result.brainSurgeonGroupChat.enabled).toBe(true);
    expect(result.voiceMode.engine).toBe('vosk');
    expect(result.voiceMode.modelSize).toBe('small');
    expect(result.voiceMode.vad).toBe(false);
    expect(result.tuiBar.refreshInterval).toBe(5000);
  });

  it('accepts apple engine', () => {
    const result = experimentalConfigSchema.parse({
      voiceMode: { engine: 'apple' },
    });
    expect(result.voiceMode.engine).toBe('apple');
  });

  it('rejects invalid engine', () => {
    expect(() =>
      experimentalConfigSchema.parse({
        voiceMode: { engine: 'invalid' },
      })
    ).toThrow();
  });

  it('rejects out-of-range vadThreshold', () => {
    expect(() =>
      experimentalConfigSchema.parse({
        voiceMode: { vadThreshold: 2.0 },
      })
    ).toThrow();
  });

  it('rejects out-of-range repetitionThreshold', () => {
    expect(() =>
      experimentalConfigSchema.parse({
        voiceMode: { repetitionThreshold: -0.1 },
      })
    ).toThrow();
  });

  it('validates all model sizes', () => {
    for (const size of ['tiny', 'base', 'small', 'medium', 'large'] as const) {
      const result = experimentalConfigSchema.parse({
        voiceMode: { modelSize: size },
      });
      expect(result.voiceMode.modelSize).toBe(size);
    }
  });
});

describe('getEffectiveFeatures', () => {
  it.each([
    ['missing config', undefined],
    ['missing experimental section', {}],
    ['non-object experimental section', { experimental: true }],
    ['missing master gate', {
      experimental: {
        harnessAdapters: { enabled: true, hermes: true, pi: true },
        brainSurgeonGroupChat: { enabled: true },
      },
    }],
    ['truthy non-boolean master gate', {
      experimental: {
        enabled: 1,
        harnessAdapters: { enabled: true, hermes: true, pi: true },
        brainSurgeonGroupChat: { enabled: true },
      },
    }],
  ])('keeps every feature off for %s', (_name, config) => {
    expect(getEffectiveFeatures(config)).toEqual({
      experimental: false,
      harnessAdapters: false,
      hermes: false,
      pi: false,
      brainSurgeonGroupChat: false,
    });
  });

  it('requires the harness parent before either adapter is effective', () => {
    expect(getEffectiveFeatures({
      experimental: {
        enabled: true,
        harnessAdapters: {
          enabled: false,
          hermes: true,
          pi: true,
        },
      },
    })).toEqual({
      experimental: true,
      harnessAdapters: false,
      hermes: false,
      pi: false,
      brainSurgeonGroupChat: false,
    });
  });

  it('requires literal booleans at each child gate', () => {
    expect(getEffectiveFeatures({
      experimental: {
        enabled: true,
        harnessAdapters: {
          enabled: true,
          hermes: 'true',
          pi: true,
        },
        brainSurgeonGroupChat: {
          enabled: 'true',
        },
      },
    })).toEqual({
      experimental: true,
      harnessAdapters: true,
      hermes: false,
      pi: true,
      brainSurgeonGroupChat: false,
    });
  });

  it('enables every flag only when all required gates are true', () => {
    expect(getEffectiveFeatures({
      experimental: {
        enabled: true,
        harnessAdapters: {
          enabled: true,
          hermes: true,
          pi: true,
        },
        brainSurgeonGroupChat: {
          enabled: true,
        },
      },
    })).toEqual({
      experimental: true,
      harnessAdapters: true,
      hermes: true,
      pi: true,
      brainSurgeonGroupChat: true,
    });
  });
});

describe('feature release maturity', () => {
  it('starts every promotable feature default-off in experimental Frontier', () => {
    expect(FEATURE_RELEASE_METADATA).toEqual({
      hermes: {
        configPath: 'experimental.harnessAdapters.hermes',
        maturity: 'frontier-experimental',
        defaultEnabled: false,
      },
      pi: {
        configPath: 'experimental.harnessAdapters.pi',
        maturity: 'frontier-experimental',
        defaultEnabled: false,
      },
      brainSurgeonGroupChat: {
        configPath: 'experimental.brainSurgeonGroupChat.enabled',
        maturity: 'frontier-experimental',
        defaultEnabled: false,
      },
    });
  });

  it('defines the promotion path without changing effective gates', () => {
    expect(FEATURE_PROMOTION_ORDER).toEqual([
      'frontier-experimental',
      'frontier',
      'brainstem-experimental',
      'brainstem-regular',
    ]);
    expect(FEATURE_RING_ORDER).toEqual([
      'canary',
      'nightly',
      'alpha',
      'beta',
      'grail',
    ]);
    const matrix = getFeatureReleaseMatrix({
      experimental: {
        enabled: true,
        harnessAdapters: {
          enabled: true,
          hermes: true,
          pi: false,
        },
        brainSurgeonGroupChat: {
          enabled: true,
        },
      },
    });
    expect(matrix).toEqual({
      evidence: {
        configHash: null,
        configValid: true,
      },
      promotionOrder: [...FEATURE_PROMOTION_ORDER],
      tracks: FEATURE_PROMOTION_ORDER.map(id => ({
        id,
        ringOrder: [...FEATURE_RING_ORDER],
      })),
      crossTrackEdges: [
        {
          from: 'frontier-experimental:grail',
          to: 'frontier:canary',
        },
        {
          from: 'frontier:grail',
          to: 'brainstem-experimental:canary',
        },
        {
          from: 'brainstem-experimental:grail',
          to: 'brainstem-regular:canary',
        },
      ],
      features: [
        {
          id: 'hermes',
          configPath: 'experimental.harnessAdapters.hermes',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: true,
        },
        {
          id: 'pi',
          configPath: 'experimental.harnessAdapters.pi',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: false,
        },
        {
          id: 'brainSurgeonGroupChat',
          configPath: 'experimental.brainSurgeonGroupChat.enabled',
          maturity: 'frontier-experimental',
          defaultEnabled: false,
          enabled: true,
        },
      ],
    });
    expect(matrix.tracks.every(
      track => track.ringOrder.join('>') === 'canary>nightly>alpha>beta>grail',
    )).toBe(true);
  });
});

describe('experimentalFeatureDescriptions', () => {
  it('has description for voiceMode', () => {
    expect(experimentalFeatureDescriptions.voiceMode).toBeDefined();
    expect(experimentalFeatureDescriptions.voiceMode.name).toBe('Local Voice Mode');
    expect(experimentalFeatureDescriptions.voiceMode.description).toBeTruthy();
    expect(experimentalFeatureDescriptions.voiceMode.risk).toBeTruthy();
  });

  it('has description for tuiBar', () => {
    expect(experimentalFeatureDescriptions.tuiBar).toBeDefined();
    expect(experimentalFeatureDescriptions.tuiBar.name).toBe('TUI Bar');
  });
});

describe('openRappterConfigSchema includes experimental', () => {
  it('accepts experimental section', () => {
    const result = validateConfig({
      experimental: {
        enabled: true,
        voiceMode: { enabled: true, engine: 'whisper' },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.experimental?.enabled).toBe(true);
    expect(result.data?.experimental?.voiceMode.engine).toBe('whisper');
  });

  it('validates config without experimental section', () => {
    const result = validateConfig({});
    expect(result.success).toBe(true);
  });
});

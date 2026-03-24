/**
 * Tests for experimental features config schema and descriptions.
 */

import { describe, it, expect } from 'vitest';
import {
  experimentalConfigSchema,
  experimentalFeatureDescriptions,
} from '../../config/sections/experimental.js';
import { openRappterConfigSchema, validateConfig } from '../../config/schema.js';

describe('experimentalConfigSchema', () => {
  it('parses empty object with defaults', () => {
    const result = experimentalConfigSchema.parse({});
    expect(result.enabled).toBe(false);
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

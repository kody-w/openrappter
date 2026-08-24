/**
 * Voice configuration schema
 */

import { z } from 'zod';

export const voiceConfigSchema = z.object({
  tts: z.object({
    provider: z.enum([
      'system',
      'local',
      'elevenlabs',
      'openai',
      'edge',
    ]).default('local'),
    voice: z.string().optional(),
    model: z.string().optional(),
    speed: z.number().default(1.0),
    autoTTS: z.boolean().default(false),
  }).optional(),
  transcription: z.object({
    provider: z.enum(['whisper', 'local']).optional(),
    language: z.string().optional(),
  }).optional(),
});

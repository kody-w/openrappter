/**
 * Voice configuration schema
 */

import { z } from 'zod';

export const voiceConfigSchema = z.object({
  tts: z.object({
    provider: z.enum(['elevenlabs', 'openai', 'edge', 'local']).optional(),
    voice: z.string().optional(),
    speed: z.number().default(1.0),
  }).optional(),
  transcription: z.object({
    provider: z.enum(['whisper', 'local']).optional(),
    language: z.string().optional(),
  }).optional(),
});

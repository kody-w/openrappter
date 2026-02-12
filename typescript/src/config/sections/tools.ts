/**
 * Tools configuration schema
 */

import { z } from 'zod';

export const toolsConfigSchema = z.object({
  browser: z.object({
    enabled: z.boolean().default(true),
    headless: z.boolean().default(true),
  }).optional(),
  web: z.object({
    enabled: z.boolean().default(true),
    maxFetchSize: z.number().default(5000),
  }).optional(),
  tts: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().optional(),
  }).optional(),
  transcription: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().optional(),
  }).optional(),
});

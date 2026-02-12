/**
 * Browser configuration schema
 */

import { z } from 'zod';

export const browserConfigSchema = z.object({
  headless: z.boolean().default(true),
  profile: z.string().optional(),
  timeout: z.number().default(30000),
  viewport: z.object({
    width: z.number().default(1280),
    height: z.number().default(720),
  }).optional(),
});

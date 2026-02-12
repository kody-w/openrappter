/**
 * Media configuration schema
 */

import { z } from 'zod';

export const mediaConfigSchema = z.object({
  maxSize: z.number().default(10485760),
  allowedTypes: z.array(z.string()).optional(),
  transcription: z.boolean().default(false),
});

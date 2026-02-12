/**
 * Logging configuration schema
 */

import { z } from 'zod';

export const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().optional(),
  maxSize: z.number().default(10485760),
  rotation: z.number().default(5),
  redaction: z.array(z.string()).optional(),
});

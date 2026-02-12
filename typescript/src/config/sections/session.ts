/**
 * Session configuration schema
 */

import { z } from 'zod';

export const sessionConfigSchema = z.object({
  maxMessages: z.number().default(100),
  ttl: z.number().default(86400000),
  compactionThreshold: z.number().default(50),
});

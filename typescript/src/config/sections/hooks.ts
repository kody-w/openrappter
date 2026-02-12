/**
 * Hooks configuration schema
 */

import { z } from 'zod';

export const hooksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().optional(),
  mappings: z.record(z.string(), z.string()).optional(),
});

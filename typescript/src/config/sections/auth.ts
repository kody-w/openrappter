/**
 * Authentication configuration schema
 */

import { z } from 'zod';

export const authConfigSchema = z.object({
  profiles: z.array(z.object({
    id: z.string(),
    provider: z.string(),
    type: z.enum(['api-key', 'oauth', 'device-code']),
    default: z.boolean().optional(),
  })).optional(),
  cooldowns: z.record(z.string(), z.number()).optional(),
});

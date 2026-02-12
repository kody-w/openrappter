/**
 * Environment configuration schema
 */

import { z } from 'zod';

export const envConfigSchema = z.object({
  shell: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

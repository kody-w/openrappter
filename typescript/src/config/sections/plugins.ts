/**
 * Plugins configuration schema
 */

import { z } from 'zod';

export const pluginsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowlist: z.array(z.string()).optional(),
  denylist: z.array(z.string()).optional(),
  loadPaths: z.array(z.string()).optional(),
  slots: z.record(z.string(), z.string()).optional(),
});

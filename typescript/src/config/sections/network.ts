/**
 * Network configuration schema
 */

import { z } from 'zod';

export const networkConfigSchema = z.object({
  tailscale: z.object({
    enabled: z.boolean().default(false),
    funnel: z.boolean().default(false),
  }).optional(),
  proxy: z.string().optional(),
  discovery: z.boolean().default(false),
});

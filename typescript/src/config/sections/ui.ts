/**
 * UI configuration schema
 */

import { z } from 'zod';

export const uiConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'auto']).default('dark'),
  toolsExpanded: z.boolean().default(true),
  showThinking: z.boolean().default(false),
});

/**
 * Security configuration schema
 */

import { z } from 'zod';

export const securityConfigSchema = z.object({
  approvalPolicy: z.enum(['deny', 'allowlist', 'full']).default('allowlist'),
  allowlists: z.object({
    tools: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    senders: z.array(z.string()).optional(),
  }).optional(),
  auditSchedule: z.string().optional(),
});

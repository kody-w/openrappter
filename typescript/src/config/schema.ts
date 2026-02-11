/**
 * Configuration schema validation using Zod
 */

import { z } from 'zod';

export const modelProviderSchema = z.enum([
  'anthropic', 'openai', 'gemini', 'bedrock', 'ollama', 'copilot',
]);

export const authTypeSchema = z.enum(['api-key', 'oauth']);

export const modelConfigSchema = z.object({
  id: z.string(),
  provider: modelProviderSchema,
  model: z.string(),
  auth: z.object({
    type: authTypeSchema,
    token_env: z.string().optional(),
  }),
  fallbacks: z.array(z.string()).optional(),
});

export const agentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: z.union([
    z.string(),
    z.object({
      primary: z.string(),
      fallbacks: z.array(z.string()).optional(),
    }),
  ]),
  workspace: z.string().optional(),
  skills: z.array(z.string()).optional(),
  sandbox: z.object({
    docker: z.boolean().optional(),
  }).optional(),
});

export const channelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).optional(),
  mentionGating: z.boolean().optional(),
});

export const gatewayConfigSchema = z.object({
  port: z.number().default(18789),
  bind: z.enum(['loopback', 'all']).default('loopback'),
  auth: z.object({
    mode: z.enum(['none', 'password']).default('none'),
    password: z.string().optional(),
  }).optional(),
});

export const memoryConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'local']).default('openai'),
  chunkTokens: z.number().default(512),
  chunkOverlap: z.number().default(64),
});

export const openRappterConfigSchema = z.object({
  models: z.array(modelConfigSchema).optional(),
  agents: z.object({
    list: z.array(agentConfigSchema).optional(),
    defaults: agentConfigSchema.partial().optional(),
  }).optional(),
  channels: z.record(z.string(), channelConfigSchema).optional(),
  gateway: gatewayConfigSchema.optional(),
  cron: z.object({ enabled: z.boolean().default(false) }).optional(),
  memory: memoryConfigSchema.optional(),
});

export type ValidatedConfig = z.infer<typeof openRappterConfigSchema>;

export function validateConfig(data: unknown): { success: boolean; data?: ValidatedConfig; error?: string } {
  const result = openRappterConfigSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}

import { resolveCopilotApiToken } from './copilot-token.js';
import type { ResolvedCopilotToken } from './copilot-token.js';
import type { CopilotModelCatalog } from '../auth/copilot-model-state.js';

export async function discoverCopilotModelCatalog(options: {
  githubToken?: string;
  resolved?: ResolvedCopilotToken;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ catalog: CopilotModelCatalog; endpoint: string }> {
  const resolved = options.resolved ?? await resolveCopilotApiToken({
    githubToken: options.githubToken ?? '',
    signal: options.signal,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${resolved.baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.95.0',
        'User-Agent': 'GitHubCopilotChat/0.22.2024',
      },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Copilot model catalog is offline.');
  }
  if (!response.ok) {
    throw new Error(`Copilot model catalog failed (HTTP ${response.status}).`);
  }
  const value = await response.json() as Record<string, unknown>;
  const data = Array.isArray(value.data) ? value.data : [];
  const models: string[] = [];
  let entryDefault: string | undefined;
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string') continue;
    models.push(record.id);
    if (record.default === true || record.is_default === true) {
      entryDefault = record.id;
    }
  }
  const declaredDefault = [
    value.default_model,
    value.defaultModel,
    value.default,
    entryDefault,
  ].find((candidate): candidate is string => typeof candidate === 'string');
  return {
    catalog: {
      models,
      ...(declaredDefault ? { defaultModel: declaredDefault } : {}),
    },
    endpoint: resolved.baseUrl,
  };
}

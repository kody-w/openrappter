import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProfileStore } from '../../auth/profiles.js';
import { CopilotAuthStateService } from '../../auth/copilot-auth-state.js';
import { CopilotModelStateService } from '../../auth/copilot-model-state.js';
import { registerAuthMethods } from '../../gateway/methods/auth-methods.js';

type Handler = (params: unknown, connection: unknown) => Promise<unknown>;
const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), '.auth-model-methods-test-'),
  );
  roots.push(directory);
  return directory;
}

function register(options: {
  dataDir: string;
  store?: AuthProfileStore;
  models: string[];
  defaultModel?: string;
  tokenUpdates?: Array<string | null>;
  modelUpdates?: string[];
}) {
  const methods = new Map<string, Handler>();
  registerAuthMethods({
    registerMethod(name, handler) {
      methods.set(name, handler as Handler);
    },
  }, {
    dataDir: options.dataDir,
    ...(options.store ? { authProfileStore: options.store } : {}),
    resolveGitHubIdentity: async () => ({ id: 1, login: 'octocat' }),
    copilotAuthStateService: new CopilotAuthStateService(async () => undefined),
    copilotModelStateService: new CopilotModelStateService(),
    resolveCopilotToken: async () => ({
      token: 'api-token',
      expiresAt: Date.now() + 60 * 60_000,
      source: 'test',
      baseUrl: 'https://api.example',
    }),
    discoverModelCatalog: async () => ({
      catalog: {
        models: options.models,
        ...(options.defaultModel
          ? { defaultModel: options.defaultModel }
          : {}),
      },
      endpoint: 'https://api.example',
    }),
    onAuthTokenUpdate: (token: string | null) =>
      options.tokenUpdates?.push(token),
    onAuthModelUpdate: (model: string) =>
      options.modelUpdates?.push(model),
  });
  return methods;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Copilot model RPC readiness', () => {
  it('blocks an explicit unsupported model until verified selection is persisted', async () => {
    const dataDir = root();
    const store = new AuthProfileStore(dataDir);
    store.add({
      id: 'octocat',
      provider: 'copilot',
      type: 'device-code',
      token: 'github-token',
      default: true,
      model: 'unsupported-model',
    });
    const tokenUpdates: Array<string | null> = [];
    const modelUpdates: string[] = [];
    const methods = register({
      dataDir,
      models: ['supported-model'],
      defaultModel: 'supported-model',
      tokenUpdates,
      modelUpdates,
    });
    await vi.waitFor(async () => {
      expect(await methods.get('auth.status')!({}, {})).toMatchObject({
        status: 'ready',
        model: {
          status: 'model-not-supported',
          configuredModel: 'unsupported-model',
        },
      });
    });
    expect(tokenUpdates).toEqual([null]);
    expect(modelUpdates).toEqual([]);

    await methods.get('auth.model.select')!(
      { model: 'supported-model' },
      {},
    );
    expect(new AuthProfileStore(dataDir).get('copilot')).toMatchObject({
      model: 'supported-model',
      previousModel: 'unsupported-model',
    });
    expect(modelUpdates).toEqual(['supported-model']);
    expect(tokenUpdates).toEqual([null, 'github-token']);
  });

  it('uses only the endpoint default when no user model was configured', async () => {
    const previous = process.env.OPENRAPPTER_MODEL;
    delete process.env.OPENRAPPTER_MODEL;
    const dataDir = root();
    const store = new AuthProfileStore(dataDir);
    store.add({
      id: 'octocat',
      provider: 'copilot',
      type: 'device-code',
      token: 'github-token',
      default: true,
    });
    const modelUpdates: string[] = [];
    const methods = register({
      dataDir,
      models: ['endpoint-default', 'other-model'],
      defaultModel: 'endpoint-default',
      modelUpdates,
    });
    await vi.waitFor(async () => {
      expect(await methods.get('auth.status')!({}, {})).toMatchObject({
        model: { status: 'ready', selectedModel: 'endpoint-default' },
      });
    });
    expect(modelUpdates).toEqual(['endpoint-default']);
    if (previous === undefined) delete process.env.OPENRAPPTER_MODEL;
    else process.env.OPENRAPPTER_MODEL = previous;
  });

  it('rolls model state and profile back when atomic persistence fails', async () => {
    const dataDir = root();
    const store = new AuthProfileStore(dataDir);
    store.add({
      id: 'octocat',
      provider: 'copilot',
      type: 'device-code',
      token: 'github-token',
      default: true,
      model: 'unsupported-model',
    });
    const methods = register({
      dataDir,
      store,
      models: ['supported-model'],
      defaultModel: 'supported-model',
    });
    await vi.waitFor(async () => {
      expect(await methods.get('auth.status')!({}, {})).toMatchObject({
        model: { status: 'model-not-supported' },
      });
    });
    vi.spyOn(store, 'updateModel').mockImplementation(() => {
      throw new Error('injected persistence failure');
    });

    await expect(methods.get('auth.model.select')!(
      { model: 'supported-model' },
      {},
    )).rejects.toThrow('could not be saved');
    expect(store.get('copilot')).toMatchObject({
      model: 'unsupported-model',
    });
    expect(await methods.get('auth.status')!({}, {})).toMatchObject({
      model: {
        status: 'model-not-supported',
        configuredModel: 'unsupported-model',
      },
    });
  });
});

export type CopilotModelStatus =
  | 'unknown'
  | 'model-checking'
  | 'ready'
  | 'model-not-supported'
  | 'offline'
  | 'error';

export type CopilotModelCode =
  | 'COPILOT_MODEL_UNKNOWN'
  | 'COPILOT_MODEL_CHECKING'
  | 'COPILOT_MODEL_READY'
  | 'COPILOT_MODEL_NOT_SUPPORTED'
  | 'COPILOT_MODEL_SELECTION_REQUIRED'
  | 'COPILOT_MODEL_CATALOG_EMPTY'
  | 'COPILOT_MODEL_OFFLINE'
  | 'COPILOT_MODEL_ERROR';

export interface CopilotModelCatalog {
  models: string[];
  defaultModel?: string;
}

export interface CopilotModelState {
  status: CopilotModelStatus;
  code: CopilotModelCode;
  message: string;
  availableModels: string[];
  configuredModel?: string;
  selectedModel?: string;
  recommendedModel?: string;
  explicitConfigured: boolean;
  retryable: boolean;
}

export const INITIAL_COPILOT_MODEL_STATE: CopilotModelState = {
  status: 'unknown',
  code: 'COPILOT_MODEL_UNKNOWN',
  message: 'Copilot model availability has not been checked yet.',
  availableModels: [],
  explicitConfigured: false,
  retryable: true,
};

export class CopilotModelNotSupportedError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      safeModelId(model)
        ? `The configured Copilot model "${model}" is not supported.`
        : 'The configured Copilot model is not supported.',
    );
    this.name = 'CopilotModelNotSupportedError';
    this.model = safeModelId(model) ? model : 'configured-model';
  }
}

interface CheckInput {
  accountId: string;
  endpoint: string;
  configuredModel?: string;
  explicitConfigured: boolean;
  discover: (signal: AbortSignal) => Promise<CopilotModelCatalog>;
  force?: boolean;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_LIKE_MODEL = /^(?:gh[opusr]_[A-Za-z0-9]{20,}|bearer[:_-]|token[:_-])/i;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 15 * 60_000;

function safeModelId(value: string | undefined): value is string {
  return Boolean(
    value && MODEL_ID.test(value) && !SECRET_LIKE_MODEL.test(value),
  );
}

export class CopilotModelStateService {
  private state: CopilotModelState = INITIAL_COPILOT_MODEL_STATE;
  private generation = 0;
  private controller?: AbortController;
  private pending?: Promise<CopilotModelState>;
  private pendingKey?: string;
  private lastInput?: CheckInput;
  private readonly cache = new Map<
    string,
    { catalog: CopilotModelCatalog; expiresAt: number }
  >();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  current(): CopilotModelState {
    return {
      ...this.state,
      availableModels: [...this.state.availableModels],
    };
  }

  captureGeneration(): number {
    return this.generation;
  }

  invalidateCredential(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
    this.pendingKey = undefined;
    this.state = INITIAL_COPILOT_MODEL_STATE;
  }

  requireReady(): void {
    if (this.state.status !== 'ready') {
      throw new Error(this.state.message);
    }
  }

  async check(input: CheckInput): Promise<CopilotModelState> {
    const configuredModel = safeModelId(input.configuredModel)
      ? input.configuredModel
      : undefined;
    const key = `${input.accountId}\n${input.endpoint}`;
    const generation = this.generation;
    this.lastInput = input;
    if (this.pending && this.pendingKey === key) {
      return this.pending;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.state = {
      status: 'model-checking',
      code: 'COPILOT_MODEL_CHECKING',
      message: 'Checking models available to this Copilot account…',
      availableModels: [],
      configuredModel,
      explicitConfigured: input.explicitConfigured,
      retryable: false,
    };
    this.pendingKey = key;
    this.pending = (async () => {
      try {
        const cached = this.cache.get(key);
        const catalog = (
          !input.force && cached && cached.expiresAt > Date.now()
        ) ? cached.catalog : normalizeCatalog(await input.discover(controller.signal));
        if (!controller.signal.aborted && generation === this.generation) {
          if (!cached || input.force || cached.expiresAt <= Date.now()) {
            this.cache.set(key, {
              catalog,
              expiresAt: Date.now() + Math.max(
                MIN_TTL_MS,
                Math.min(this.ttlMs, MAX_TTL_MS),
              ),
            });
            while (this.cache.size > 8) {
              const oldest = this.cache.keys().next().value as string | undefined;
              if (!oldest) break;
              this.cache.delete(oldest);
            }
          }
          this.state = evaluateCatalog(input, catalog);
        }
      } catch (error) {
        if (!controller.signal.aborted && generation === this.generation) {
          const offline = /fetch|network|offline|enotfound|econn/i.test(
            error instanceof Error ? error.message : '',
          );
          this.state = {
            status: offline ? 'offline' : 'error',
            code: offline ? 'COPILOT_MODEL_OFFLINE' : 'COPILOT_MODEL_ERROR',
            message: offline
              ? 'The Copilot model catalog is unavailable while offline.'
              : 'The Copilot model catalog could not be verified.',
            availableModels: [],
            configuredModel,
            explicitConfigured: input.explicitConfigured,
            retryable: true,
          };
        }
      } finally {
        if (this.controller === controller) this.controller = undefined;
        if (this.pendingKey === key) {
          this.pending = undefined;
          this.pendingKey = undefined;
        }
      }
      return this.current();
    })();
    return this.pending;
  }

  async refreshAfterUnsupported(model: string): Promise<string | null> {
    if (!this.lastInput) {
      this.reportUnsupported(model);
      return null;
    }
    const state = await this.check({ ...this.lastInput, force: true });
    return !state.explicitConfigured && state.status === 'ready'
      ? state.selectedModel ?? null
      : null;
  }

  reportUnsupported(model: string): CopilotModelState {
    this.controller?.abort();
    this.generation += 1;
    const safeModel = safeModelId(model) ? model : undefined;
    const availableModels = this.state.availableModels.filter((candidate) =>
      candidate !== safeModel
    );
    this.state = {
      status: 'model-not-supported',
      code: 'COPILOT_MODEL_NOT_SUPPORTED',
      message: safeModel
        ? `The configured Copilot model "${safeModel}" is not supported by this account.`
        : 'The configured Copilot model is not supported by this account.',
      availableModels,
      configuredModel: safeModel,
      recommendedModel: availableModels.includes(
        this.state.recommendedModel ?? '',
      ) ? this.state.recommendedModel : undefined,
      explicitConfigured: true,
      retryable: true,
    };
    return this.current();
  }

  async select(
    model: string,
    persist: (model: string, previous?: string) => Promise<void> | void,
  ): Promise<CopilotModelState> {
    if (!this.state.availableModels.includes(model)) {
      throw new CopilotModelNotSupportedError(model);
    }
    const previous = this.current();
    this.controller?.abort();
    this.generation += 1;
    this.state = {
      ...previous,
      status: 'model-checking',
      code: 'COPILOT_MODEL_CHECKING',
      message: `Saving verified Copilot model "${model}"…`,
      retryable: false,
    };
    try {
      await persist(model, previous.configuredModel);
      this.state = {
        status: 'ready',
        code: 'COPILOT_MODEL_READY',
        message: `Copilot model "${model}" is ready.`,
        availableModels: [...previous.availableModels],
        configuredModel: model,
        selectedModel: model,
        recommendedModel: previous.recommendedModel,
        explicitConfigured: true,
        retryable: false,
      };
    } catch (error) {
      this.state = previous;
      throw new Error('Copilot model selection could not be saved.', {
        cause: error,
      });
    }
    return this.current();
  }
}

function normalizeCatalog(value: CopilotModelCatalog): CopilotModelCatalog {
  const models = Array.from(new Set(
    value.models.filter((model) =>
      MODEL_ID.test(model) && !SECRET_LIKE_MODEL.test(model)
    ),
  )).sort();
  return {
    models,
    ...(value.defaultModel && models.includes(value.defaultModel)
      ? { defaultModel: value.defaultModel }
      : {}),
  };
}

function evaluateCatalog(
  input: CheckInput,
  catalog: CopilotModelCatalog,
): CopilotModelState {
  const configuredModel = input.configuredModel
    && MODEL_ID.test(input.configuredModel)
    && !SECRET_LIKE_MODEL.test(input.configuredModel)
      ? input.configuredModel
      : undefined;
  if (catalog.models.length === 0) {
    return {
      status: 'error',
      code: 'COPILOT_MODEL_CATALOG_EMPTY',
      message: 'This Copilot endpoint returned no available models.',
      availableModels: [],
      configuredModel,
      explicitConfigured: input.explicitConfigured,
      retryable: true,
    };
  }
  if (configuredModel && catalog.models.includes(configuredModel)) {
    return {
      status: 'ready',
      code: 'COPILOT_MODEL_READY',
      message: `Copilot model "${configuredModel}" is ready.`,
      availableModels: catalog.models,
      configuredModel,
      selectedModel: configuredModel,
      recommendedModel: catalog.defaultModel,
      explicitConfigured: input.explicitConfigured,
      retryable: false,
    };
  }
  if (!input.explicitConfigured && catalog.defaultModel) {
    return {
      status: 'ready',
      code: 'COPILOT_MODEL_READY',
      message: `Copilot model "${catalog.defaultModel}" is ready.`,
      availableModels: catalog.models,
      selectedModel: catalog.defaultModel,
      recommendedModel: catalog.defaultModel,
      explicitConfigured: false,
      retryable: false,
    };
  }
  return {
    status: 'model-not-supported',
    code: configuredModel
      ? 'COPILOT_MODEL_NOT_SUPPORTED'
      : 'COPILOT_MODEL_SELECTION_REQUIRED',
    message: configuredModel
      ? `The configured Copilot model "${configuredModel}" is not supported by this account.`
      : 'Choose a model returned by this Copilot endpoint.',
    availableModels: catalog.models,
    configuredModel,
    recommendedModel: catalog.defaultModel,
    explicitConfigured: input.explicitConfigured,
    retryable: true,
  };
}

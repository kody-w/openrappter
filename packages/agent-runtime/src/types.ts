import type { ToolDescription } from "@rapp-work/model-provider";
import type {
  AuthorizedEffectContext, CommitProof, EffectOutcome, JsonValue, WorkspaceScope, WorkServicePort,
} from "@rapp-work/work-service";
import type { ModelProvider } from "@rapp-work/model-provider";

export interface AgentPolicy {
  readonly workspaceId: string;
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentTools: number;
  readonly maxDurationMs: number;
  readonly maxOutputTokens: number;
}

export interface AgentDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly policy: AgentPolicy;
}

export interface PersistedAgentDefinition {
  readonly definition: AgentDefinition;
  readonly revision: string;
  readonly proof: CommitProof;
}

export interface AuthorizedTool {
  readonly description: ToolDescription;
  validate(input: JsonValue): void;
  execute(
    input: JsonValue,
    context: AuthorizedEffectContext & {
      readonly capability: object;
      readonly scope: WorkspaceScope;
      readonly taskId: string;
      readonly runId: string;
    },
  ): Promise<EffectOutcome>;
}

export interface RuntimeLimits {
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentTools: number;
  readonly maxStepsPerRun: number;
  readonly maxToolCallsPerRun: number;
  readonly maxDurationMs: number;
  readonly maxOutputTokens: number;
}

export interface RuntimeDependencies {
  readonly work: WorkServicePort;
  readonly provider: ModelProvider;
  readonly tools: readonly AuthorizedTool[];
  readonly limits: RuntimeLimits;
}

export interface RunRequest {
  readonly scope: WorkspaceScope;
  readonly taskId: string;
  readonly runId: string;
  readonly input: string;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly runId: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "unresolved";
  readonly steps: number;
  readonly toolCalls: number;
  readonly output?: string;
  readonly reason?: string;
  readonly proof?: CommitProof;
  readonly replayed?: boolean;
}

export class AgentRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentRuntimeError";
  }
}

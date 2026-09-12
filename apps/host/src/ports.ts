import type {
  Agent, AgentInput, Approval, Artifact, Automation, AutomationInput, Check,
  Computer, Diagnostics, Provider, Run, Settings, Snapshot, Task, TaskInput,
  WorkEvent,
} from "./contracts.js";

export type Permission = `${"work" | "agents" | "automations" | "settings"}:${"read" | "write"}`
  | "runtime:execute" | "computer:read" | "computer:control" | "diagnostics:read" | "events:read";
export interface Principal { id: string; workspaceId: string; permissions: readonly Permission[] }
export interface RequestContext { principal: Principal; requestId: string }
export interface ServicePort {
  check(): Promise<Check>;
  close?(): Promise<void>;
}
export interface StoragePort extends ServicePort {
  initialize(): Promise<void>;
  read(workspaceId: string): Promise<Snapshot>;
}
export interface ProjectionStoragePort extends StoragePort {
  transact<T>(workspaceId: string, update: (draft: Snapshot) => T | Promise<T>): Promise<T>;
}
export interface SecurityPort extends ServicePort {
  authenticate(bearer: string): Promise<Principal | null>;
  authorize(principal: Principal, permission: Permission): Promise<boolean>;
}
export interface RuntimePort extends ServicePort {
  start(context: RequestContext, input: { runId: string; task: Task; agent: Agent; settings: Settings }): Promise<Run>;
  cancel(context: RequestContext, run: Run): Promise<Run>;
  decide(context: RequestContext, input: { approval: Approval; decision: "approved" | "denied"; reason: string }): Promise<void>;
  schedule(context: RequestContext, automation: AutomationInput): Promise<{ nextRunAt: string | null }>;
}
export interface ProviderPort extends ServicePort {
  list(context: RequestContext): Promise<Provider[]>;
  configure(context: RequestContext, input: { id: string; connectionRef: string }): Promise<Provider>;
}
export interface ComputerPort extends ServicePort {
  inspect(context: RequestContext): Promise<Computer>;
  start(context: RequestContext): Promise<Computer>;
  stop(context: RequestContext): Promise<Computer>;
}
export interface DiagnosticsPort extends ServicePort {
  snapshot(context: RequestContext): Promise<Diagnostics>;
  record(event: { code: string; method: string }): void;
}
export interface WorkPort extends ServicePort {
  subscribe(listener: (workspaceId: string, event: WorkEvent) => void): () => void;
  snapshot(context: RequestContext): Promise<Snapshot>;
  createTask(context: RequestContext, input: TaskInput): Promise<Task>;
  assignTask(context: RequestContext, input: { id: string; agentId: string }): Promise<Task>;
  saveAgent(context: RequestContext, input: AgentInput): Promise<Agent>;
  saveAutomation(context: RequestContext, input: AutomationInput, runtime: RuntimePort): Promise<Automation>;
  updateSettings(context: RequestContext, input: Settings): Promise<Settings>;
  startRun(context: RequestContext, id: string, runtime: RuntimePort, provider: ProviderPort): Promise<Run>;
  cancelRun(context: RequestContext, id: string, runtime: RuntimePort): Promise<Run>;
  decideApproval(context: RequestContext, input: { id: string; decision: "approved" | "denied"; reason: string }, runtime: RuntimePort): Promise<Approval>;
  readArtifact(context: RequestContext, id: string): Promise<{ artifact: Artifact; content: string }>;
}

// No optional services: an unavailable adapter must explicitly report that state.
export interface HostServices {
  storage: StoragePort;
  security: SecurityPort;
  work: WorkPort;
  runtime: RuntimePort;
  provider: ProviderPort;
  computer: ComputerPort;
  diagnostics: DiagnosticsPort;
}

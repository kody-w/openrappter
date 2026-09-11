import { gateway, type GatewayClient } from './gateway.js';
import type { ChatMessage, ChatSessionSummary, ToolCallResult } from '../types.js';
import { WorkRappClient, WorkCommitFailure, type WorkVerification } from './work-rapp.js';
import { workJsonObject, workSubject, type WorkFrameScope } from '../../../src/rapp/work-contract.js';
import type { JsonObject } from '../../../src/rappids/types.js';

export interface RappProjected {
  rapp?: WorkVerification;
}

export type Presence = 'active' | 'idle' | 'offline' | 'unknown';

export interface WorkAgent extends RappProjected {
  id: string;
  name: string;
  description: string;
  presence: Presence;
}

export interface WorkWorkspace extends RappProjected {
  id: string;
  agentId: string;
  name: string;
  rootPath?: string;
  memoryPath?: string;
  isolation: 'dedicated' | 'shared' | 'unknown';
  status: Presence;
}

export interface WorkThread extends ChatSessionSummary, RappProjected {
  title?: string;
}

export interface WorkEvidence extends RappProjected {
  id: string;
  title: string;
  source: string;
  excerpt: string;
  url?: string;
}

export interface WorkMessage extends ChatMessage, RappProjected {
  citations?: WorkEvidence[];
  toolCalls?: WorkToolCall[];
}

export interface WorkToolCall extends ToolCallResult, RappProjected {}

export interface WorkApproval extends RappProjected {
  id: string;
  command: string;
  description: string;
  status: 'pending';
  agentId?: string;
  timestamp?: string | number;
  expiresAt?: number;
}

export interface ApprovalReceipt extends RappProjected {
  ok: true;
  approvalId: string;
  approved: boolean;
  status: 'approved' | 'denied';
}

export interface VmStatus extends RappProjected {
  id: string;
  name: string;
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'unavailable' | 'error';
  local: boolean;
  viewerUrl?: string;
  updatedAt?: string;
  message?: string;
  activeAgentId?: string;
}

export interface WorkspaceListResult {
  workspaces: WorkWorkspace[];
}

export interface WorkspaceGetResult {
  workspace: WorkWorkspace;
}

export type Capability<T> =
  | { state: 'live'; data: T }
  | { state: 'unavailable' | 'error'; method: string; detail: string; rapp?: WorkVerification }
  | { state: 'loading' | 'offline'; detail: string };

export function offline<T>(): Capability<T> {
  return { state: 'offline', detail: 'Connect to the gateway to load live data.' };
}

export function isMethodUnavailable(error: unknown, method: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; message?: unknown };
  // A permission error, timeout, or malformed payload must never unlock demo data.
  if (failure.code !== undefined) return failure.code === -32601;
  return failure.message === `Method not found: ${method}`
    || failure.message === `Unknown method: ${method}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid gateway response.');
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Incomplete gateway response.');
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function array(value: unknown, key?: string): unknown[] {
  const items = Array.isArray(value) ? value : key ? record(value)[key] : value;
  if (!Array.isArray(items)) throw new Error('Expected a gateway list.');
  return items;
}

function presence(value: unknown): Presence {
  return value === 'active' || value === 'idle' || value === 'offline'
    ? value : 'unknown';
}

function workspace(value: unknown): WorkWorkspace {
  const item = record(value);
  return {
    id: requiredText(item.id),
    agentId: requiredText(item.agentId),
    name: optionalText(item.name) || requiredText(item.id),
    rootPath: optionalText(item.rootPath),
    memoryPath: optionalText(item.memoryPath),
    isolation: item.isolation === 'dedicated' || item.isolation === 'shared'
      ? item.isolation : 'unknown',
    status: presence(item.status),
  };
}

function vmStatus(value: unknown): VmStatus {
  const item = record(value);
  if (!['running', 'stopped', 'starting', 'stopping', 'unavailable', 'error'].includes(String(item.state))) {
    throw new Error('Invalid VM status response.');
  }
  return {
    id: optionalText(item.id) || 'omarchy',
    name: optionalText(item.name) || 'Omarchy',
    state: item.state as VmStatus['state'],
    local: item.local === true,
    viewerUrl: optionalText(item.viewerUrl),
    updatedAt: optionalText(item.updatedAt),
    message: optionalText(item.message),
    activeAgentId: optionalText(item.activeAgentId),
  };
}

export function localViewerUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function evidenceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

export class WorkService {
  private readonly provenance: WorkRappClient;

  constructor(private readonly client: Pick<GatewayClient, 'call'> = gateway) {
    this.provenance = new WorkRappClient(client);
  }

  resetRappVerification() { this.provenance.reset(); }

  private projection(value: object): JsonObject {
    return workJsonObject(JSON.parse(JSON.stringify(value)));
  }

  private async attest<T extends object>(scope: WorkFrameScope, ids: string[], value: T): Promise<T & RappProjected> {
    const rapp = await this.provenance.verify({ scope, subject: workSubject(scope, ...ids), data: this.projection(value) });
    return { ...value, rapp };
  }

  private async read<T>(
    method: string,
    request: () => Promise<unknown>,
    decode: (value: unknown) => T | Promise<T>,
  ): Promise<Capability<T>> {
    try {
      return { state: 'live', data: await decode(await request()) };
    } catch (error) {
      return {
        state: isMethodUnavailable(error, method) ? 'unavailable' : 'error',
        method,
        detail: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkCommitFailure ? { rapp: error.rapp } : {}),
      };
    }
  }

  listWorkspaces(): Promise<Capability<WorkWorkspace[]>> {
    return this.read('workspace.list',
      () => this.client.call<WorkspaceListResult | WorkWorkspace[]>('workspace.list'),
      (value) => Promise.all(array(value, 'workspaces').map((entry) => {
        const item = workspace(entry);
        return this.attest('workspace', [item.id], item);
      })));
  }

  getWorkspace(workspaceId: string): Promise<Capability<WorkWorkspace>> {
    return this.read('workspace.get',
      () => this.client.call<WorkspaceGetResult | WorkWorkspace>('workspace.get', { workspaceId }),
      (value) => {
        const result = workspace(record(value).workspace ?? value);
        if (result.id !== workspaceId) throw new Error('Workspace response did not match the selection.');
        return this.attest('workspace', [result.id], result);
      });
  }

  vmStatus(): Promise<Capability<VmStatus>> {
    return this.read('vm.status', () => this.client.call<VmStatus>('vm.status'),
      (value) => this.attest('vm', ['omarchy'], vmStatus(value)));
  }

  startVm(): Promise<Capability<VmStatus>> {
    return this.changeVm('vm.start');
  }

  stopVm(): Promise<Capability<VmStatus>> {
    return this.changeVm('vm.stop');
  }

  private changeVm(method: 'vm.start' | 'vm.stop'): Promise<Capability<VmStatus>> {
    return this.read('work.rapp.commit',
      () => this.provenance.commit(method, workSubject('vm', 'omarchy'), {}, (value) => this.projection(vmStatus(value))),
      (value) => {
        const result = value as { data: JsonObject; rapp: WorkVerification };
        return { ...vmStatus(result.data), rapp: result.rapp };
      });
  }

  listAgents(): Promise<Capability<WorkAgent[]>> {
    return this.read('agents.list',
      () => this.client.call<WorkAgent[]>('agents.list'),
      (value) => Promise.all(array(value).map((entry) => {
        const item = record(entry);
        return this.attest('agent', [requiredText(item.id)], {
          id: requiredText(item.id),
          name: optionalText(item.name) || requiredText(item.id),
          description: optionalText(item.description) || 'Local gateway agent',
          presence: presence(item.presence),
        });
      })));
  }

  listThreads(): Promise<Capability<WorkThread[]>> {
    return this.read('chat.list', () => this.client.call<WorkThread[]>('chat.list'),
      (value) => Promise.all(array(value).map((entry) => {
        const item = record(entry);
        return this.attest('task', [requiredText(item.id)], {
          id: requiredText(item.id),
          agentId: requiredText(item.agentId),
          messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
          createdAt: requiredText(item.createdAt),
          updatedAt: requiredText(item.updatedAt),
          title: optionalText(item.title) || optionalText(item.label),
        });
      })));
  }

  messages(sessionId: string): Promise<Capability<WorkMessage[]>> {
    return this.read('chat.messages',
      () => this.client.call<WorkMessage[]>('chat.messages', { sessionId, limit: 100 }),
      (value) => Promise.all(array(value).map(async (entry) => {
        const item = record(entry);
        if (!['user', 'assistant', 'system', 'tool'].includes(String(item.role))
          || typeof item.content !== 'string') throw new Error('Invalid thread message.');
        const message: WorkMessage = {
          id: requiredText(item.id),
          role: item.role as WorkMessage['role'],
          content: item.content,
          timestamp: requiredText(item.timestamp),
        };
        if (Array.isArray(item.citations)) {
          message.citations = item.citations.map((value) => {
            const citation = record(value);
            return {
              id: requiredText(citation.id),
              title: requiredText(citation.title),
              source: requiredText(citation.source),
              excerpt: optionalText(citation.excerpt) || '',
              url: optionalText(citation.url),
            };
          });
        }
        if (Array.isArray(item.toolCalls)) {
          message.toolCalls = item.toolCalls.map((value) => {
            const tool = record(value);
            if (!['pending', 'running', 'success', 'error'].includes(String(tool.status))) {
              throw new Error('Invalid tool status.');
            }
            return {
              id: requiredText(tool.id),
              name: requiredText(tool.name),
              arguments: {},
              result: tool.result,
              status: tool.status as 'pending' | 'running' | 'success' | 'error',
              error: optionalText(tool.error),
            };
          });
        }
        const result = await this.attest('message', [sessionId, message.id], message);
        if (result.citations) {
          result.citations = await Promise.all(result.citations.map((citation) =>
            this.attest('evidence', [sessionId, message.id, citation.id], citation)));
        }
        if (result.toolCalls) {
          result.toolCalls = await Promise.all(result.toolCalls.map((tool) =>
            this.attest('run', [sessionId, message.id, tool.id], tool)));
        }
        return result;
      })));
  }

  pendingApprovals(): Promise<Capability<WorkApproval[]>> {
    return this.read('exec.pending',
      () => this.client.call<WorkApproval[]>('exec.pending'),
      (value) => Promise.all(array(value).map((entry) => {
        const item = record(entry);
        if (item.status !== 'pending') throw new Error('Invalid approval status.');
        return this.attest('approval', [requiredText(item.id)], {
          id: requiredText(item.id),
          command: requiredText(item.command),
          description: optionalText(item.description) || 'Review this execution request.',
          status: 'pending' as const,
          agentId: optionalText(item.agentId),
          expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : undefined,
        });
      })));
  }

  respondToApproval(approvalId: string, approved: boolean): Promise<Capability<ApprovalReceipt>> {
    const decode = (value: unknown): ApprovalReceipt => {
        const receipt = record(value);
        if (
          receipt.ok !== true || receipt.approvalId !== approvalId
          || receipt.approved !== approved
          || receipt.status !== (approved ? 'approved' : 'denied')
        ) throw new Error('The gateway did not confirm the approval decision.');
        return { ok: true, approvalId, approved, status: approved ? 'approved' : 'denied' };
    };
    return this.read('work.rapp.commit',
      () => this.provenance.commit('exec.respond', workSubject('approval', approvalId), { approvalId, approved },
        (value) => this.projection(decode(value))),
      (value) => {
        const result = value as { data: JsonObject; rapp: WorkVerification };
        return { ...decode(result.data), rapp: result.rapp };
      });
  }
}

export const workService = new WorkService();

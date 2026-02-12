/**
 * Execution approval RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ApprovalRequest {
  id: string;
  command: string;
  agent: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
}

interface ApprovalManager {
  createRequest(command: string, agent: string): Promise<ApprovalRequest>;
  resolveRequest(
    id: string,
    approved: boolean,
    reason?: string
  ): Promise<void>;
  getPendingRequests(): ApprovalRequest[];
  getApprovalSettings(): Record<string, unknown>;
  updateApprovalSettings(settings: Record<string, unknown>): Promise<void>;
}

interface ExecMethodsDeps {
  approvalManager?: ApprovalManager;
}

export function registerExecMethods(
  server: MethodRegistrar,
  deps?: ExecMethodsDeps
): void {
  server.registerMethod<
    { command: string; agent: string },
    { request: ApprovalRequest }
  >('exec.approval.request', async (params) => {
    const manager = deps?.approvalManager;
    if (!manager) throw new Error('Approval manager not available');
    const request = await manager.createRequest(params.command, params.agent);
    return { request };
  });

  server.registerMethod<
    { id: string; approved: boolean; reason?: string },
    { success: boolean }
  >('exec.approval.resolve', async (params) => {
    const manager = deps?.approvalManager;
    if (!manager) throw new Error('Approval manager not available');
    await manager.resolveRequest(params.id, params.approved, params.reason);
    return { success: true };
  });

  server.registerMethod<void, { requests: ApprovalRequest[] }>(
    'exec.approvals.get',
    async () => {
      const manager = deps?.approvalManager;
      if (!manager) return { requests: [] };
      return { requests: manager.getPendingRequests() };
    }
  );

  server.registerMethod<
    { settings: Record<string, unknown> },
    { success: boolean }
  >('exec.approvals.set', async (params) => {
    const manager = deps?.approvalManager;
    if (!manager) throw new Error('Approval manager not available');
    await manager.updateApprovalSettings(params.settings);
    return { success: true };
  });
}

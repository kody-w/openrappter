import { VmError, type VmExecRequest, type VmSupervisor } from '../../vm/types.js';
import { RPC_ERROR, type RpcError, type RpcMethodHandler } from '../types.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: RpcMethodHandler<P, R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export interface VmMethodDependencies {
  getSupervisor(): VmSupervisor | Promise<VmSupervisor>;
  /** Trusted-local auth:none is not sufficient for a computer-control API. */
  hasCredentials(): boolean;
  broadcast?(event: 'vm', payload: unknown): void;
}

function hasNoParams(value: unknown): boolean {
  return (
    value === undefined
    || (
      typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    )
  );
}

export function registerVmMethods(server: MethodRegistrar, deps: VmMethodDependencies): void {
  const register = (name: string, handler: (params: unknown, vm: VmSupervisor) => Promise<unknown>) => {
    server.registerMethod(name, async (params, connection) => {
      if (!connection.authenticated || !deps.hasCredentials()) {
        throw new VmError('authentication_required', 'VM access requires configured token/password authentication.');
      }
      return handler(params, await deps.getSupervisor());
    }, { requiresAuth: true });
  };
  const lifecycle = (name: string, run: (vm: VmSupervisor) => Promise<unknown>) => {
    register(name, async (params, vm) => {
      if (!hasNoParams(params)) {
        throw new VmError('invalid_request', 'VM lifecycle methods accept no renderer configuration or command arguments.');
      }
      const result = await run(vm);
      if (name !== 'vm.status' && deps.broadcast) {
        deps.broadcast('vm', { action: name.slice(3), result });
      }
      return result;
    });
  };
  lifecycle('vm.status', async (vm) => ({ ...await vm.status(), frames: vm.getFrames() }));
  lifecycle('vm.start', (vm) => vm.start());
  lifecycle('vm.stop', (vm) => vm.stop());
  lifecycle('vm.restart', (vm) => vm.restart());
  register('vm.exec', async (params, vm) => {
    const result = await vm.exec(params as VmExecRequest);
    if (deps.broadcast) deps.broadcast('vm', { action: 'exec', result });
    return result;
  });
}

/** Keep typed VM errors identical on the production HTTP and WS transports. */
export function vmRpcError(error: unknown): RpcError | undefined {
  if (!(error instanceof VmError)) return undefined;
  const code = error.code === 'invalid_request' ? RPC_ERROR.INVALID_PARAMS
    : ['authentication_required', 'workspace_denied'].includes(error.code) ? RPC_ERROR.UNAUTHORIZED
      : error.code === 'readiness_timeout' ? RPC_ERROR.TIMEOUT : RPC_ERROR.INTERNAL_ERROR;
  return { code, message: error.message, data: { vmCode: error.code, ...(error.evidence ? { evidence: error.evidence } : {}) } };
}

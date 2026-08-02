import type { SurgeonService } from '../../surgeon/service.js';
import type {
  SurgeonConsultRequest,
  SurgeonProcedureApproval,
} from '../../surgeon/types.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export function registerSurgeonMethods(
  server: MethodRegistrar,
  service: SurgeonService,
): void {
  server.registerMethod('surgeon.patient', async () => service.getPatient());
  server.registerMethod('surgeon.cases', async () => service.listCases());
  server.registerMethod<{ caseId: string }>(
    'surgeon.case',
    async ({ caseId }) => service.getCase(caseId),
  );
  server.registerMethod<SurgeonConsultRequest>(
    'surgeon.turn',
    async (params) => service.consult(params),
    { requiresAuth: true },
  );
  server.registerMethod<SurgeonProcedureApproval>(
    'surgeon.procedure.approve',
    async (params) => service.approveProcedure(params),
    { requiresAuth: true },
  );
  server.registerMethod<SurgeonProcedureApproval>(
    'surgeon.procedure.reject',
    async (params) => service.rejectProcedure(params),
    { requiresAuth: true },
  );
  server.registerMethod<SurgeonProcedureApproval>(
    'surgeon.procedure.operate',
    async (params) => service.operate(params),
    { requiresAuth: true },
  );
}

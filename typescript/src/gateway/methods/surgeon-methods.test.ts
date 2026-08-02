import { describe, expect, it, vi } from 'vitest';
import type { SurgeonService } from '../../surgeon/service.js';
import { registerSurgeonMethods } from './surgeon-methods.js';

describe('registerSurgeonMethods', () => {
  it('registers adaptive reads and consent-gated mutations', async () => {
    const methods = new Map<string, {
      handler: (params: unknown, connection?: unknown) => Promise<unknown>;
      requiresAuth: boolean;
    }>();
    const service = {
      getPatient: vi.fn(async () => ({ patient: 'OpenRappter' })),
      listCases: vi.fn(() => []),
      getCase: vi.fn(() => ({ id: 'case-1' })),
      consult: vi.fn(async () => ({ case: { id: 'case-1' } })),
      approveProcedure: vi.fn(async () => ({ status: 'approved' })),
      rejectProcedure: vi.fn(async () => ({ status: 'rejected' })),
      operate: vi.fn(async () => ({ status: 'recovered' })),
    } as unknown as SurgeonService;

    registerSurgeonMethods({
      registerMethod(name, handler, options) {
        methods.set(name, {
          handler: handler as unknown as (
            params: unknown,
            connection?: unknown,
          ) => Promise<unknown>,
          requiresAuth: options?.requiresAuth ?? false,
        });
      },
    }, service);

    expect(Array.from(methods.keys())).toEqual([
      'surgeon.patient',
      'surgeon.cases',
      'surgeon.case',
      'surgeon.turn',
      'surgeon.procedure.approve',
      'surgeon.procedure.reject',
      'surgeon.procedure.operate',
    ]);
    expect(methods.get('surgeon.patient')?.requiresAuth).toBe(false);
    expect(methods.get('surgeon.turn')?.requiresAuth).toBe(true);
    expect(methods.get('surgeon.procedure.approve')?.requiresAuth).toBe(true);
    expect(methods.get('surgeon.procedure.operate')?.requiresAuth).toBe(true);

    await methods.get('surgeon.turn')!.handler({
      userInput: 'Examine the patient',
    });
    expect(service.consult).toHaveBeenCalledWith({
      userInput: 'Examine the patient',
    });
  });
});

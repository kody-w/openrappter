import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatOptions,
  LLMProvider,
  Message,
  ProviderResponse,
} from '../providers/types.js';
import { SurgeonService } from './service.js';
import type { SurgeonPatientSnapshot } from './types.js';

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly name = 'Scripted Copilot';
  readonly messages: Message[][] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async chat(messages: Message[], _options?: ChatOptions): Promise<ProviderResponse> {
    this.messages.push(messages);
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted Copilot response');
    return response;
  }
}

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openrappter-surgeon-'));
  roots.push(root);
  return root;
}

function patient(state: SurgeonPatientSnapshot['state'] = 'stable'): SurgeonPatientSnapshot {
  return {
    capturedAt: '2026-08-02T01:00:00.000Z',
    patient: 'OpenRappter',
    version: '1.10.0',
    state,
    uptimeSeconds: 300,
    tissues: [
      {
        id: 'gateway',
        label: 'Brainstem',
        status: state,
        summary: state === 'stable' ? 'Gateway is responsive.' : 'Gateway needs attention.',
      },
      {
        id: 'agents',
        label: 'Agent cortex',
        status: 'stable',
        summary: '32 agents available.',
        value: 32,
      },
    ],
    inventory: {
      agents: Array.from({ length: 32 }, (_, index) => `Agent${index + 1}`),
      channels: ['telegram'],
      scheduledJobs: ['DailyTip', 'Dream'],
    },
    metrics: {
      connections: 1,
      agents: 32,
      configuredChannels: 1,
      connectedChannels: 1,
      scheduledJobs: 2,
      activeCases: 0,
    },
  };
}

function completion(value: unknown): ProviderResponse {
  return {
    content: JSON.stringify(value),
    tool_calls: null,
  };
}

const consultation = {
  response: 'OpenRappter is stable. The agent cortex is available and the brainstem is responsive.',
  voice_line: 'OpenRappter is stable and ready.',
  prompt: 'What should I examine next?',
  options: [
    { label: 'Inspect agent cortex', value: 'Inspect the agent cortex for capability gaps.' },
    { label: 'Check autonomic jobs', value: 'Check scheduled jobs for unhealthy behavior.' },
  ],
  diagnosis: {
    summary: 'No acute fault detected.',
    severity: 'stable',
    findings: ['Gateway responsive', 'Agent registry populated'],
  },
  procedure: null,
};

const highRiskProposal = {
  response: 'The channel nerve is disconnected. I recommend a bounded configuration repair.',
  voice_line: 'A channel repair is ready for your approval.',
  prompt: 'Review the proposed procedure.',
  options: [
    { label: 'Explain the risk', value: 'Explain the exact risk before I approve this procedure.' },
    { label: 'Inspect another system', value: 'Inspect the gateway before changing anything.' },
  ],
  diagnosis: {
    summary: 'One configured channel is disconnected.',
    severity: 'warning',
    findings: ['Configured channel is offline'],
  },
  procedure: {
    title: 'Repair channel configuration',
    summary: 'Inspect the configured channel, correct only its invalid settings, and reconnect it.',
    risk: 'high',
    steps: [
      'Inspect the configured channel without revealing secrets.',
      'Correct only invalid channel settings.',
      'Reconnect and verify delivery health.',
    ],
    expected_outcome: 'The configured channel reconnects without changing unrelated settings.',
    verification: [
      'The channel reports connected.',
      'No unrelated configuration changed.',
    ],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('SurgeonService', () => {
  it('turns live patient telemetry into a validated adaptive Copilot turn', async () => {
    const provider = new ScriptedProvider([completion(consultation)]);
    const inspectPatient = vi.fn(async () => patient());
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient,
    });

    const result = await service.consult({
      userInput: 'Run a full diagnostic.',
    });

    expect(result.patient.state).toBe('stable');
    expect(result.case.status).toBe('observing');
    expect(result.turn.kind).toBe('consultation');
    expect(result.turn.response).toContain('agent cortex');
    expect(result.turn.options).toEqual(consultation.options);
    expect(result.turn.procedure).toBeUndefined();
    expect(inspectPatient).toHaveBeenCalledOnce();

    const transcript = JSON.stringify(provider.messages[0]);
    expect(transcript).toContain('Run a full diagnostic.');
    expect(provider.messages[0].at(-1)?.content).toContain('"patient":"OpenRappter"');
    expect(transcript).toContain('untrusted patient data');
  });

  it('binds a high-risk procedure to an immutable digest and explicit confirmation', async () => {
    const provider = new ScriptedProvider([
      completion(highRiskProposal),
      completion({
        status: 'recovered',
        summary: 'The channel is connected and unrelated settings are unchanged.',
        evidence: ['Shell agent completed the bounded repair', 'Post-operative telemetry is stable'],
      }),
    ]);
    const inspectPatient = vi
      .fn<() => Promise<SurgeonPatientSnapshot>>()
      .mockResolvedValueOnce(patient('degraded'))
      .mockResolvedValueOnce(patient('degraded'))
      .mockResolvedValueOnce(patient('stable'));
    const executeProcedure = vi.fn(async () => ({
      summary: 'Channel reconnected.',
      agentLogs: ['Performed Shell → channel probe returned connected'],
    }));
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient,
      executeProcedure,
    });

    const consultationResult = await service.consult({
      userInput: 'Repair the disconnected channel.',
    });
    const procedure = consultationResult.case.procedure;

    expect(consultationResult.case.status).toBe('proposed');
    expect(procedure?.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.operate({
      caseId: consultationResult.case.id,
      procedureId: procedure!.id,
      digest: procedure!.digest,
    })).rejects.toThrow(/approved/i);
    await expect(service.approveProcedure({
      caseId: consultationResult.case.id,
      procedureId: procedure!.id,
      digest: '0'.repeat(64),
      confirmation: 'OPERATE OPENRAPPTER',
    })).rejects.toThrow(/changed|digest/i);
    await expect(service.approveProcedure({
      caseId: consultationResult.case.id,
      procedureId: procedure!.id,
      digest: procedure!.digest,
    })).rejects.toThrow('OPERATE OPENRAPPTER');

    const approved = await service.approveProcedure({
      caseId: consultationResult.case.id,
      procedureId: procedure!.id,
      digest: procedure!.digest,
      confirmation: 'OPERATE OPENRAPPTER',
    });
    expect(approved.status).toBe('approved');

    const recovered = await service.operate({
      caseId: consultationResult.case.id,
      procedureId: procedure!.id,
      digest: procedure!.digest,
    });

    expect(executeProcedure).toHaveBeenCalledOnce();
    expect(recovered.status).toBe('recovered');
    expect(recovered.outcome?.status).toBe('recovered');
    expect(recovered.outcome?.evidence).toContain('Shell agent completed the bounded repair');
  });

  it('never reports recovery when no OpenRappter tool actually ran', async () => {
    const provider = new ScriptedProvider([completion({
      ...highRiskProposal,
      procedure: {
        ...highRiskProposal.procedure,
        risk: 'low',
      },
    })]);
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient: async () => patient('degraded'),
      executeProcedure: async () => ({
        summary: 'I think the repair worked.',
        agentLogs: [],
      }),
    });

    const proposed = await service.consult({ userInput: 'Fix the channel.' });
    const procedure = proposed.case.procedure!;
    await service.approveProcedure({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });
    const result = await service.operate({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });

    expect(result.status).toBe('needs_attention');
    expect(result.outcome?.status).toBe('needs_attention');
    expect(result.outcome?.summary).toMatch(/no patient tools executed/i);
    expect(provider.messages).toHaveLength(1);
  });

  it('treats a hallucinated agent name as no surgery at all', async () => {
    const provider = new ScriptedProvider([completion({
      ...highRiskProposal,
      procedure: {
        ...highRiskProposal.procedure,
        risk: 'low',
      },
    })]);
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient: async () => patient('degraded'),
      executeProcedure: async () => ({
        summary: 'The repair is complete.',
        agentLogs: ['Unknown agent: ChannelRepairer'],
      }),
    });

    const proposed = await service.consult({ userInput: 'Fix the channel.' });
    const procedure = proposed.case.procedure!;
    await service.approveProcedure({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });
    const result = await service.operate({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });

    expect(result.status).toBe('needs_attention');
    expect(result.outcome?.summary).toMatch(/no patient tools executed/i);
    // The verifier is never consulted, so no model can call this a recovery.
    expect(provider.messages).toHaveLength(1);
  });

  it('supersedes consent when the OpenRappter patient changes before operation', async () => {
    const provider = new ScriptedProvider([completion({
      ...highRiskProposal,
      procedure: {
        ...highRiskProposal.procedure,
        risk: 'low',
      },
    })]);
    const changedPatient = patient('degraded');
    changedPatient.inventory.agents[0] = 'ReplacementAgent';
    const inspectPatient = vi
      .fn<() => Promise<SurgeonPatientSnapshot>>()
      .mockResolvedValueOnce(patient('degraded'))
      .mockResolvedValueOnce(changedPatient);
    const executeProcedure = vi.fn(async () => ({
      summary: 'Should never run.',
      agentLogs: ['Performed Shell'],
    }));
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient,
      executeProcedure,
    });

    const proposed = await service.consult({ userInput: 'Repair the channel.' });
    const procedure = proposed.case.procedure!;
    await service.approveProcedure({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });

    await expect(service.operate({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    })).rejects.toThrow(/patient state changed/i);
    expect(executeProcedure).not.toHaveBeenCalled();
    expect(service.getCase(proposed.case.id).status).toBe('needs_attention');
  });

  it('refuses a late examination that would replace a procedure in surgery', async () => {
    let releaseOperation: (() => void) | undefined;
    const operationGate = new Promise<void>(resolve => {
      releaseOperation = resolve;
    });

    const provider = new ScriptedProvider([
      completion({
        ...highRiskProposal,
        procedure: { ...highRiskProposal.procedure, risk: 'low' },
      }),
      completion({
        status: 'recovered',
        summary: 'The approved repair landed.',
        evidence: ['Verified by post-operative telemetry'],
      }),
    ]);
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient: async () => patient('degraded'),
      executeProcedure: async () => {
        await operationGate;
        return {
          summary: 'Repair complete.',
          agentLogs: ['Performed Shell → channel reconnected'],
        };
      },
    });

    const proposed = await service.consult({ userInput: 'Fix the channel.' });
    const procedure = proposed.case.procedure!;
    await service.approveProcedure({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });

    const operation = service.operate({
      caseId: proposed.case.id,
      procedureId: procedure.id,
      digest: procedure.digest,
    });
    while (service.getCase(proposed.case.id).status !== 'operating') {
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    await expect(service.consult({
      caseId: proposed.case.id,
      userInput: 'Actually, examine something else.',
    })).rejects.toThrow(/currently in surgery/i);

    releaseOperation!();
    const recovered = await operation;
    expect(recovered.status).toBe('recovered');
    expect(recovered.procedure?.id).toBe(procedure.id);
    // The late examination never reached Copilot, so it consumed no response.
    expect(provider.messages).toHaveLength(2);
  });

  it('accepts a real Copilot proposal that expresses a list as one string', async () => {
    const provider = new ScriptedProvider([completion({
      ...highRiskProposal,
      diagnosis: {
        ...highRiskProposal.diagnosis,
        findings: 'The configured channel is offline.',
      },
      procedure: {
        ...highRiskProposal.procedure,
        risk: 'low',
        steps: '1. Inspect the channel.\n2. Correct invalid settings.',
        verification: 'The channel reports connected and nothing else changed.',
      },
    })]);
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient: async () => patient('degraded'),
    });

    const result = await service.consult({ userInput: 'Repair the channel.' });

    expect(result.turn.kind).toBe('proposal');
    expect(result.turn.procedure?.steps).toEqual([
      'Inspect the channel.',
      'Correct invalid settings.',
    ]);
    expect(result.turn.procedure?.verification).toEqual([
      'The channel reports connected and nothing else changed.',
    ]);
    expect(result.turn.diagnosis?.findings).toEqual([
      'The configured channel is offline.',
    ]);
    // One provider call: the response was accepted without a repair pass.
    expect(provider.messages).toHaveLength(1);
  });

  it('persists cases so a restart preserves consent and outcome history', async () => {    const dataDir = tempRoot();
    const provider = new ScriptedProvider([completion(consultation)]);
    const service = new SurgeonService({
      dataDir,
      provider,
      inspectPatient: async () => patient(),
    });

    const created = await service.consult({ userInput: 'Examine the patient.' });
    const restarted = new SurgeonService({
      dataDir,
      provider: new ScriptedProvider([]),
      inspectPatient: async () => patient(),
    });

    expect(restarted.getCase(created.case.id)).toEqual(created.case);
    expect(restarted.listCases()).toHaveLength(1);
  });

  it('surfaces malformed Copilot output as an error turn instead of fake success', async () => {
    const provider = new ScriptedProvider([
      { content: 'not json', tool_calls: null },
      { content: '{"response":"still incomplete"}', tool_calls: null },
    ]);
    const service = new SurgeonService({
      dataDir: tempRoot(),
      provider,
      inspectPatient: async () => patient(),
    });

    const result = await service.consult({ userInput: 'Inspect the patient.' });

    expect(result.case.status).toBe('needs_attention');
    expect(result.turn.kind).toBe('error');
    expect(result.turn.response).toMatch(/could not be validated/i);
    expect(result.turn.options[0].value).toContain('try the examination again');
    expect(provider.messages).toHaveLength(2);
  });
});

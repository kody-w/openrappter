/**
 * The approval gate — one interface, two ways to satisfy it.
 *
 * This is the same loop the assistant runs on the phone, with the human
 * optionally taken out of it:
 *
 *   propose -> verify -> decide -> commit
 *
 * On a phone call, "verify" is a callback to a person who says yes.
 * In an autonomous coding loop, "verify" is running the gate and reading the
 * result. The shape is identical, the authority is different, and the Second
 * Brain records both the same way — so afterwards you can always ask *who or
 * what* approved a given commitment, and get a real answer.
 *
 * Keeping this as one abstraction is deliberate. The moment autonomous work
 * gets its own separate, softer path is the moment it stops being auditable.
 */

import type { SecondBrain } from './brain.js';
import type { CallAgent } from './call-agent.js';

export interface ApprovalRequest {
  approvalId: string;
  question: string;
  detail?: string;
  appointmentId?: string;
  /** Free-form context for autonomous approvers (e.g. a command to run). */
  evidence?: EvidenceSpec;
}

export interface ApprovalOutcome {
  approved: boolean;
  /** How the decision was reached — recorded verbatim in the brain. */
  via: string;
  /** Why. For evidence approvers this is the proof. */
  rationale: string;
  /** True when nobody and nothing answered. Silence is never consent. */
  undetermined?: boolean;
}

export interface Approver {
  readonly name: string;
  decide(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * Human in the loop: ring the owner and ask.
 * This is the JARVIS behaviour — the agent negotiated something outside its
 * mandate, so it stops and calls you before committing.
 */
export class PhoneApprover implements Approver {
  readonly name = 'phone';

  constructor(
    private readonly agent: CallAgent,
    private readonly ownerNumber?: string,
  ) {}

  async decide(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const result = await this.agent.callBackForApproval({
      approvalId: request.approvalId,
      question: request.question,
      appointmentId: request.appointmentId,
      to: this.ownerNumber,
    });

    return {
      approved: result.approved,
      via: 'phone',
      rationale: result.approved ? 'owner said yes on a callback' : 'owner did not agree on a callback',
    };
  }
}

export interface EvidenceSpec {
  /** What must be true. Human-readable, recorded with the decision. */
  claim: string;
  /**
   * The check. Resolves to whether the claim holds, plus proof.
   * A thrown error is treated as a failed check, never as approval.
   */
  check: () => Promise<{ passed: boolean; proof: string }>;
}

/**
 * Human out of the loop: the gate is satisfied by evidence.
 *
 * The autonomous loop is only allowed to self-approve when it can produce proof
 * — a green test run, a passing lint, a verified chain. No proof, no approval:
 * an unavailable or throwing check is a denial, not a shrug.
 */
export class EvidenceApprover implements Approver {
  readonly name = 'evidence';

  constructor(private readonly fallback?: Approver) {}

  async decide(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const evidence = request.evidence;

    if (!evidence) {
      // Nothing to verify against. Escalate if we can, otherwise refuse.
      if (this.fallback) return this.fallback.decide(request);
      return {
        approved: false,
        via: this.name,
        rationale: 'no evidence supplied and no human to ask',
        undetermined: true,
      };
    }

    let passed = false;
    let proof: string;

    try {
      const result = await evidence.check();
      passed = result.passed;
      proof = result.proof;
    } catch (error) {
      passed = false;
      proof = `check failed to run: ${(error as Error).message}`;
    }

    if (!passed && this.fallback) {
      const escalated = await this.fallback.decide(request);
      return { ...escalated, rationale: `${proof}; escalated: ${escalated.rationale}` };
    }

    return {
      approved: passed,
      via: this.name,
      rationale: `${evidence.claim} — ${proof}`,
    };
  }
}

/** Never approves. The safe default when autonomy is switched off. */
export class ManualApprover implements Approver {
  readonly name = 'manual';

  async decide(): Promise<ApprovalOutcome> {
    return {
      approved: false,
      via: this.name,
      rationale: 'autonomous approval is disabled; a person must decide',
      undetermined: true,
    };
  }
}

/**
 * Run a full propose -> verify -> commit cycle through whichever approver is
 * configured, recording every step in the Second Brain.
 *
 * The caller does not know or care whether a human or a test suite said yes —
 * which is the whole point.
 */
export class ApprovalGate {
  constructor(
    private readonly approver: Approver,
    private readonly brain?: SecondBrain,
  ) {}

  async request(input: {
    subject: string;
    detail?: string;
    ref?: string;
    evidence?: EvidenceSpec;
  }): Promise<{ approvalId: string | null; outcome: ApprovalOutcome }> {
    const approvalId =
      (await this.brain?.requestApproval({
        subject: input.subject,
        detail: input.detail,
        ref: input.ref,
        channel: this.approver.name,
      })) ?? null;

    const outcome = await this.approver.decide({
      approvalId: approvalId ?? 'local',
      question: input.subject,
      detail: input.detail,
      appointmentId: input.ref,
      evidence: input.evidence,
    });

    // PhoneApprover records its own decision during the callback; anything else
    // records it here. Silence stays pending rather than becoming a denial.
    if (this.brain && approvalId && this.approver.name !== 'phone' && !outcome.undetermined) {
      await this.brain.decideApproval(
        approvalId,
        outcome.approved ? 'approve' : 'deny',
        outcome.via,
        outcome.rationale,
      );
    }

    return { approvalId, outcome };
  }
}

import {
  CardStateStore,
  MAX_REPLAY_NONCES,
  RappidCardError,
} from './types.js';
import type { CardTrustStateInput } from './types.js';

/** Fixture-only state store. Production requires `SqliteCardStateStore`. */
export class BoundedCardStateStore extends CardStateStore {
  private readonly policyStates = new Map<string, { sequence: number; hash: string }>();
  private readonly authorizationStates = new Map<string, { sequence: number; hash: string }>();
  private readonly revocationStates = new Map<string, { sequence: number; hash: string }>();
  private readonly nonces = new Map<string, true>();

  constructor(
    private readonly limit = MAX_REPLAY_NONCES,
    initialNonces: readonly string[] = [],
  ) {
    super();
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('state store limit must be a positive integer');
    }
    for (const nonce of initialNonces) this.addNonce(nonce);
  }

  recordPolicy(
    policyId: string,
    sequence: number,
    documentHash: string,
  ): void {
    const current = this.policyStates.get(policyId);
    if (sequence < (current?.sequence ?? -1)) {
      throw new RappidCardError(
        'policy_rollback',
        'signed policy sequence moved backwards',
      );
    }
    if (
      current
      && sequence === current.sequence
      && documentHash !== current.hash
    ) {
      throw new RappidCardError(
        'policy_equivocation',
        'signed policy changed without advancing its sequence',
      );
    }
    this.policyStates.set(policyId, { sequence, hash: documentHash });
  }

  record(input: CardTrustStateInput, claimNonce: boolean): void {
    const policyState = this.policyStates.get(input.policyId);
    const authorizationKey = `${input.policyId}\0${input.authorizationId}`;
    const authorizationState = this.authorizationStates.get(authorizationKey);
    const revocationState = this.revocationStates.get(input.policyId);
    if (input.policySequence < (policyState?.sequence ?? -1)) {
      throw new RappidCardError(
        'policy_rollback',
        'signed policy sequence moved backwards',
      );
    }
    if (
      policyState
      && input.policySequence === policyState.sequence
      && input.policyHash !== policyState.hash
    ) {
      throw new RappidCardError(
        'policy_equivocation',
        'signed policy changed without advancing its sequence',
      );
    }
    if (input.authorizationSequence < (authorizationState?.sequence ?? -1)) {
      throw new RappidCardError(
        'authorization_rollback',
        'signed authorization sequence moved backwards',
      );
    }
    if (
      authorizationState
      && input.authorizationSequence === authorizationState.sequence
      && input.authorizationHash !== authorizationState.hash
    ) {
      throw new RappidCardError(
        'authorization_equivocation',
        'signed authorization changed without advancing its sequence',
      );
    }
    if (input.revocationSequence < (revocationState?.sequence ?? -1)) {
      throw new RappidCardError(
        'revocation_rollback',
        'signed revocation sequence moved backwards',
      );
    }
    if (
      revocationState
      && input.revocationSequence === revocationState.sequence
      && input.revocationHash !== revocationState.hash
    ) {
      throw new RappidCardError(
        'revocation_equivocation',
        'signed revocation view changed without advancing its sequence',
      );
    }
    if (this.nonces.has(input.nonce)) {
      throw new RappidCardError(
        'duplicate_nonce',
        'card nonce has already been accepted',
      );
    }
    this.policyStates.set(input.policyId, {
      sequence: input.policySequence,
      hash: input.policyHash,
    });
    this.authorizationStates.set(
      authorizationKey,
      {
        sequence: input.authorizationSequence,
        hash: input.authorizationHash,
      },
    );
    this.revocationStates.set(input.policyId, {
      sequence: input.revocationSequence,
      hash: input.revocationHash,
    });
    if (claimNonce) this.addNonce(input.nonce);
  }

  values(): string[] {
    return [...this.nonces.keys()];
  }

  private addNonce(nonce: string): void {
    if (this.nonces.has(nonce)) this.nonces.delete(nonce);
    this.nonces.set(nonce, true);
    while (this.nonces.size > this.limit) {
      const oldest = this.nonces.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.nonces.delete(oldest);
    }
  }
}

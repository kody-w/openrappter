import type {
  AuthorizedEffect, CanonicalPort, CommitJournal, EffectOutcome, JsonObject, JsonValue,
  ProjectionReducer, VerifiedFrame, VerifiedHistory, VerifiedProjection, WorkAuthorizationPort,
  WorkCommand, WorkCommitResult, WorkServicePort, WorkSnapshot, WorkspaceHistoryPort, WorkspaceScope,
} from "./ports.js";
import {
  assertExtension, jsonCopy, object, reduceHistory, sameScope, text,
  validateCommand, validateScope, WorkServiceError,
} from "./history.js";

export interface WorkServiceDependencies {
  readonly history: WorkspaceHistoryPort;
  readonly canonical: CanonicalPort;
  readonly authorization: WorkAuthorizationPort;
  readonly now?: () => Date;
}

export class WorkService implements WorkServicePort {
  private readonly now: () => Date;

  constructor(private readonly dependencies: WorkServiceDependencies) {
    if (!dependencies.history || !dependencies.canonical || !dependencies.authorization) {
      throw new WorkServiceError("missing_mandatory_port");
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  private async scan(journal: CommitJournal, scope: WorkspaceScope): Promise<VerifiedHistory> {
    const history = jsonCopy(await this.dependencies.canonical.scan(await journal.readCommitted(), scope));
    if (!sameScope(scope, history.scope)) throw new WorkServiceError("wrong_history_owner");
    reduceHistory(history, this.dependencies.canonical);
    return history;
  }

  async read(capability: object, scope: WorkspaceScope): Promise<WorkSnapshot> {
    const ownedScope = jsonCopy(scope);
    validateScope(ownedScope);
    await this.dependencies.authorization.authorizeRead(capability, ownedScope);
    return this.dependencies.history.withExclusive(capability, ownedScope, async (journal) =>
      reduceHistory(await this.scan(journal, ownedScope), this.dependencies.canonical));
  }

  async project<T>(
    capability: object,
    scope: WorkspaceScope,
    reducer: ProjectionReducer<T>,
  ): Promise<VerifiedProjection<T>> {
    const snapshot = await this.read(capability, scope);
    const committed = snapshot.commands.filter((command) => command.state === "committed");
    return {
      value: committed.reduce((value, command) => reducer.apply(value, command), reducer.initial()),
      heads: snapshot.heads,
      proofs: committed.map((command) => command.proof),
    };
  }

  async commit(
    capability: object,
    input: WorkCommand,
    effect: AuthorizedEffect,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<WorkCommitResult> {
    const command = jsonCopy(input);
    validateCommand(command);
    const { canonical, authorization, history } = this.dependencies;
    const commandHash = canonical.digest(command as unknown as JsonValue);
    if (!text(commandHash)) throw new WorkServiceError("invalid_digest");
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    await authorization.authorizeRead(capability, command.scope);
    return history.withExclusive(capability, command.scope, async (journal) => {
      let current = await this.scan(journal, command.scope);
      const request = { command, commandHash, heads: current.heads };
      const principal = await authorization.authorizeCommand(capability, request);
      if (!text(principal.principalId)) throw new WorkServiceError("invalid_principal");
      const previous = reduceHistory(current, canonical).commands.find(
        (entry) => entry.command.idempotencyKey === command.idempotencyKey,
      );
      if (previous) {
        if (previous.commandHash !== commandHash) throw new WorkServiceError("idempotency_conflict");
        return { ...previous, replayed: true };
      }
      signal.throwIfAborted();
      let intentRef: string | undefined;
      let stage: "persist" | "effect" = "persist";
      const unresolved = (reason: "persistence-uncertain" | "effect-uncertain"): WorkCommitResult => ({
        state: "unresolved", command, commandHash, reason, replayed: false,
        ...(intentRef === undefined ? {} : { intentRef }),
      });
      const appendAndScan = async (event: JsonObject): Promise<VerifiedFrame> => {
        await journal.append([jsonCopy(event)], current.heads);
        const next = await this.scan(journal, command.scope);
        assertExtension(current, next);
        const existing = new Set(current.frames.map((frame) => frame.ref));
        const matching = next.frames.filter((frame) => !existing.has(frame.ref) && frame.stream === "body"
          && canonical.digest(frame.value) === canonical.digest(event));
        if (matching.length !== 1 || next.frames.length !== current.frames.length + 1) {
          throw new WorkServiceError("append_not_read_back");
        }
        current = next;
        return matching[0]!;
      };
      try {
        const intent = await appendAndScan({
          type: "work.intent", version: 1, commandHash,
          command: command as unknown as JsonValue, principalId: principal.principalId,
          at: this.now().toISOString(),
        });
        intentRef = intent.ref;
        let outcome: EffectOutcome | undefined;
        let permit: object | undefined;
        if (signal.aborted) {
          outcome = {
            status: "cancelled", value: { code: "cancelled_before_effect" }, events: [],
            receipts: [{ kind: "no-effect", reason: "cancelled_before_effect" }],
          };
        } else {
          try {
            permit = await authorization.issuePermit(capability, {
              ...request, heads: current.heads, intentRef,
            });
            if (!permit || typeof permit !== "object") throw new WorkServiceError("invalid_permit");
          } catch {
            outcome = {
              status: "denied", value: { code: "permit_denied" }, events: [],
              receipts: [{ kind: "no-effect", reason: "permit_denied" }],
            };
          }
          if (permit) {
            if (signal.aborted) {
              outcome = {
                status: "cancelled", value: { code: "cancelled_before_effect" }, events: [],
                receipts: [{ kind: "no-effect", reason: "cancelled_before_effect" }],
              };
            } else {
              stage = "effect";
              outcome = jsonCopy(await effect({ permit, command, commandHash, intentRef, signal }));
            }
          }
        }
        if (!outcome || !["succeeded", "failed", "cancelled", "denied"].includes(outcome.status)
          || !Array.isArray(outcome.receipts) || outcome.receipts.length === 0
          || !outcome.receipts.every(object) || !Array.isArray(outcome.events)
          || !outcome.events.every(object) || outcome.value === undefined) {
          return unresolved("effect-uncertain");
        }
        // A thrown effect is ambiguous. Only an explicit, acknowledged outcome is terminal.
        stage = "persist";
        const terminal = await appendAndScan({
          type: "work.outcome", version: 1, commandHash, intentRef,
          status: outcome.status, value: outcome.value, events: [...outcome.events],
          receiptsHash: canonical.digest([...outcome.receipts]),
          at: this.now().toISOString(),
        });
        const outcomeRef = terminal.ref;
        await appendAndScan({
          type: "work.evidence", version: 1, commandHash, intentRef, outcomeRef,
          receipts: [...outcome.receipts], at: this.now().toISOString(),
        });
        const committed = reduceHistory(current, canonical).commands.find(
          (entry) => entry.commandHash === commandHash,
        );
        if (!committed || committed.state !== "committed") return unresolved("persistence-uncertain");
        return { ...committed, replayed: false };
      } catch {
        return unresolved(stage === "effect" ? "effect-uncertain" : "persistence-uncertain");
      }
    });
  }
}

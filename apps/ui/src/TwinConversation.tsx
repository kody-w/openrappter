import { Badge, formatDate, Icon } from "./components";
import { approvalRecommendationSchema, type Snapshot, type TwinConversation as ConversationData, type TwinDraft } from "./model";
import { prepareProposal, proposalDisposition, proposalHash } from "./proposals";

const labels = { workspace: "Workspace", task: "Task", agent: "Agent", automation: "Routine", settings: "Settings", approval: "Approval recommendation", clarification: "A little more context" };
export function TwinConversation({ conversation, workspaceId, snapshot, lastProposal, pendingMessage, busy, connected, dispositions, onReview, onApply, onDismiss, onReply }: {
  conversation: ConversationData | null; workspaceId: string | null; snapshot: Snapshot | null;
  lastProposal: TwinDraft | null; pendingMessage: string; busy: boolean; connected: boolean;
  dispositions: Record<string, string>; onReview: (proposal: TwinDraft) => void;
  onApply: (proposal: TwinDraft) => void; onDismiss: (proposal: TwinDraft) => void; onReply: () => void;
}) {
  const proposals = new Map(conversation?.proposals.map((proposal) => [proposal.id, proposal]) ?? []);
  if (lastProposal) proposals.set(lastProposal.id, lastProposal);
  const shown = new Set(conversation?.turns.map((turn) => turn.proposalId).filter(Boolean) ?? []);
  const proposalCard = (proposal: TwinDraft) => {
    const prepared = prepareProposal(proposal, workspaceId, snapshot);
    const recommendation = proposal.kind === "approval" ? approvalRecommendationSchema.safeParse(proposal.draft) : null;
    const recorded = recommendation?.success ? snapshot?.approvals.find((item) =>
      item.id === recommendation.data.approvalId && item.operationHash === recommendation.data.operationHash && item.state !== "pending") : null;
    const disposition = recorded ? `Human ${recorded.state}` : dispositions[proposal.id] ?? proposalDisposition(conversation, proposal.id);
    const enabledRoutines = prepared?.kind === "workspace" ? prepared.input.starterRoutines.filter((routine) => routine.enabled).length : 0;
    return <article className={`proposal-card${disposition ? " proposal-resolved" : ""}`} aria-label={`${labels[proposal.kind]} proposal`}>
      <div className="row between wrap"><span className="proposal-kind"><Icon name={proposal.kind === "approval" ? "shield" : proposal.kind === "automation" ? "clock" : proposal.kind === "clarification" ? "chat" : "document"} size={16} />{labels[proposal.kind]}</span>
        <Badge tone={disposition === "Applied" ? "positive" : "neutral"}>{disposition ?? (prepared ? "Ready for your review" : "Needs your reply")}</Badge></div>
      <h3>{proposal.summary}</h3>
      {proposal.kind === "clarification" || proposal.missing.length > 0 ? <>
        <ul className="follow-up-questions">{proposal.missing.map((question, index) => <li key={index}>{question}</li>)}</ul>
        <p className="small-text muted">Your Twin will complete the draft after your reply. No form or action is available yet.</p>
        {!disposition && <div className="proposal-actions"><button className="button secondary" disabled={!connected || busy} onClick={onReply}>Reply to Twin<Icon name="arrow" size={16} /></button>
          <button className="text-button" disabled={!connected || busy || !proposalHash(proposal)} onClick={() => onDismiss(proposal)}>Dismiss</button></div>}
      </> : <>
        {prepared && <div className="proposal-preview">
          {prepared.kind === "workspace" && <><strong>{prepared.input.name}</strong><p>{prepared.input.purpose}</p><span className="small-text muted">{prepared.input.twin.name} · Lead agent: {prepared.input.leadAgent.name} · {prepared.input.starterRoutines.length} starter routines</span>
            {enabledRoutines > 0 && <Badge tone="attention">{enabledRoutines} {enabledRoutines === 1 ? "routine requests" : "routines request"} activation</Badge>}</>}
          {prepared.kind === "task" && <><strong>{prepared.input.title}</strong><p>{prepared.input.instructions}</p><span className="small-text muted">{snapshot?.agents.find((item) => item.id === prepared.input.agentId)?.name ?? "Unassigned"} · {prepared.input.priority} priority · Queued until started</span></>}
          {prepared.kind === "agent" && <><strong>{prepared.input.name}</strong><p>{prepared.input.role}</p><span className="small-text muted">{prepared.input.model} · {prepared.input.computerPolicy} computer access · {prepared.input.approvalPolicy} approval</span></>}
          {prepared.kind === "automation" && <><strong>{prepared.input.name}</strong><p>{prepared.input.instructions}</p><span className="small-text muted">{prepared.input.cadence.kind === "interval" ? `Every ${prepared.input.cadence.minutes} minutes` : `${prepared.input.cadence.kind} at ${prepared.input.cadence.at} · ${prepared.input.cadence.timezone}`} · {prepared.input.enabled ? "Requests activation" : "Saved as draft"}</span></>}
          {prepared.kind === "settings" && <><strong>{prepared.input.workspaceName}</strong><p>{prepared.input.appearance.theme} theme · {prepared.input.appearance.density} density · {prepared.input.work.approvalPolicy} approval</p><span className="small-text muted">All unchanged settings are preserved in the prefilled review.</span></>}
          {prepared.kind === "approval" && <><strong>Twin recommends: {prepared.input.recommendation}</strong><p>{prepared.input.reason}</p><span className="small-text muted">Recommendation only. No approval or denial has been recorded.</span></>}
        </div>}
        {!disposition && !prepared && <p className="inline-note">This proposal cannot be applied in its current state. Ask your Twin to refresh or complete it.</p>}
        {!disposition && <div className="proposal-actions">
          {prepared?.kind === "approval" ? <button className="button primary" disabled={!connected || busy} onClick={() => onReview(proposal)}>Review decision</button>
            : prepared && <button className="button primary" disabled={!connected || busy} onClick={() => onApply(proposal)}>{proposal.kind === "settings" ? "Approve & apply settings" : `Approve & create ${proposal.kind === "automation" ? "routine" : proposal.kind}`}</button>}
          {prepared && prepared.kind !== "approval" && <button className="button secondary" disabled={!connected || busy} onClick={() => onReview(proposal)}>Review details</button>}
          <button className="text-button" disabled={!connected || busy || !proposalHash(proposal)} onClick={() => onDismiss(proposal)}>Dismiss</button>
        </div>}
        <p className="proposal-footnote">Drafted by your Twin · {Math.round(proposal.confidence * 100)}% model confidence, not verification</p>
      </>}
    </article>;
  };
  return <section className="conversation-log" role="log" aria-label="Twin conversation" aria-live="polite" aria-relevant="additions text">
    <ol>{conversation?.turns.map((turn) => {
      const proposal = turn.proposalId ? proposals.get(turn.proposalId) : undefined;
      return <li key={turn.id} className={`conversation-turn turn-${turn.role}`}>
        <div className="turn-author"><span className={turn.role === "assistant" ? "twin-mark" : "human-mark"} aria-hidden="true">{turn.role === "assistant" ? <Icon name="chat" size={16} /> : "Y"}</span><strong>{turn.role === "assistant" ? "Work Twin" : "You"}</strong><time dateTime={turn.createdAt}>{formatDate(turn.createdAt)}</time></div>
        <p className="turn-content preserve">{turn.content}</p>{proposal && proposalCard(proposal)}
      </li>;
    })}
      {[...proposals.values()].filter((proposal) => !shown.has(proposal.id)).map((proposal) => <li key={proposal.id} className="conversation-turn turn-assistant"><div className="turn-author"><span className="twin-mark" aria-hidden="true"><Icon name="chat" size={16} /></span><strong>Work Twin</strong></div><p className="turn-content preserve">{proposal.assistantMessage}</p>{proposalCard(proposal)}</li>)}
      {pendingMessage && <li className="conversation-turn turn-user pending-turn"><div className="turn-author"><strong>You</strong><span>Sending to Twin…</span></div><p className="turn-content preserve">{pendingMessage}</p></li>}
    </ol>
  </section>;
}

import { Badge, Icon, formatDate } from "./components";
import { twinEvolutionEventSchema, type AutomationInput, type Snapshot, type TwinConversation, type WorkspaceSummary } from "./model";

export function WorkspaceOrganization({ workspace, snapshot, conversation, discussRoutine, connected }: {
  workspace: WorkspaceSummary; snapshot: Snapshot; conversation: TwinConversation | null;
  discussRoutine: (routine: AutomationInput) => void;
  connected: boolean;
}) {
  const organization = workspace.organization;
  const receipt = [...(conversation?.events ?? [])].reverse().find((event) => event.kind === "evolution" && event.workspaceId === workspace.id
    && twinEvolutionEventSchema.safeParse(event).success && event.references && conversation?.proposals.some((proposal) => proposal.id === event.proposalId
      && proposal.workspaceId === workspace.id && proposal.basis?.proposalHash === event.references!.proposalHash
      && proposal.basis.verification?.state === "verified"
      && proposal.basis.verification.sourceFrameHash === event.references!.proposalFrameHash)
    && conversation.turns.some((turn) => turn.workspaceId === workspace.id && turn.verification?.state === "verified"
      && turn.verification.sourceFrameHash === event.references!.conversationFrameHash));
  if (!receipt && !organization.sections.length && !organization.suggestedRoutines.length && !organization.twinSummary) return null;
  return <section className="workspace-organization" aria-label="Conversation-organized workspace">
    {receipt && connected && <p className="evolution-receipt" role="status"><Icon name="check" size={14} />Workspace evolved from this conversation
      <time dateTime={receipt.createdAt}>{formatDate(receipt.createdAt)}</time></p>}
    {receipt?.references && <details className="evolution-references"><summary>Canonical evolution references</summary>
      <dl className="metadata compact"><div><dt>Conversation frame</dt><dd className="mono">{receipt.references.conversationFrameHash}</dd></div>
        <div><dt>Proposal frame</dt><dd className="mono">{receipt.references.proposalFrameHash}</dd></div>
        <div><dt>Proposal hash</dt><dd className="mono">{receipt.references.proposalHash}</dd></div>
        <div><dt>Evolution frame</dt><dd className="mono">{receipt.references.evolutionFrameHash}</dd></div></dl>
      <p className="small-text muted">Local integrity only; not factual truth, authorship, or promotion-grade trust.</p>
    </details>}
    {organization.defaultFocus !== "conversation" && <p className="small-text muted">Suggested focus: {organization.defaultFocus}</p>}
    {organization.twinSummary && <p className="preserve">{organization.twinSummary}</p>}
    <div className="organization-sections">{organization.sections.map((section) => <article key={section.id}>
      <h3>{section.title}</h3><p className="preserve">{section.description}</p>
      {section.taskIds.length > 0 && <ul>{section.taskIds.map((id) => {
        const task = snapshot.tasks.find((task) => task.id === id);
        return task ? <li key={id}>{task.title}</li> : null;
      })}</ul>}
    </article>)}</div>
    {organization.suggestedRoutines.length > 0 && <div className="organization-sections">
      {organization.suggestedRoutines.map((routine) => <article key={routine.id}>
        <div className="row between"><h3>{routine.name}</h3><Badge>Suggestion only</Badge></div>
        <p>{routine.instructions}</p><p className="small-text">Disabled. No schedule or external effect has been enabled.</p>
        <button className="text-button" disabled={!connected} onClick={() => discussRoutine(routine)}>Discuss this routine</button>
      </article>)}
    </div>}
  </section>;
}

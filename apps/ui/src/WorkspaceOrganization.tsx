import { Badge, Icon, formatDate } from "./components";
import type { AutomationInput, Snapshot, TwinConversation, WorkspaceSummary } from "./model";

export function WorkspaceOrganization({ workspace, snapshot, conversation, discussRoutine }: {
  workspace: WorkspaceSummary; snapshot: Snapshot; conversation: TwinConversation | null;
  discussRoutine: (routine: AutomationInput) => void;
}) {
  const organization = workspace.organization;
  const receipt = [...(conversation?.events ?? [])].reverse().find((event) => event.kind === "evolution" && event.workspaceId === workspace.id);
  if (!receipt && !organization.sections.length && !organization.suggestedRoutines.length && !organization.twinSummary) return null;
  return <section className="workspace-organization" aria-label="Conversation-organized workspace">
    {receipt && <p className="evolution-receipt" role="status"><Icon name="check" size={14} />Workspace evolved from this conversation
      <time dateTime={receipt.createdAt}>{formatDate(receipt.createdAt)}</time></p>}
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
        <button className="text-button" onClick={() => discussRoutine(routine)}>Discuss this routine</button>
      </article>)}
    </div>}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import { Agents } from "./Agents";
import { Automations } from "./Automations";
import { Badge, Icon, Modal } from "./components";
import { AgentForm, ApprovalForm, AutomationForm, SavedTaskForm, SettingsForm, TaskForm, WorkspaceForm } from "./forms";
import {
  agentInputSchema, automationInputSchema, twinMessageRequestSchema, workspaceSummarySchema,
  type AgentInput, type Approval, type Area, type Artifact, type AutomationInput, type Settings as SettingsData,
  type Task, type TwinDraft, type TwinTarget, type WorkspaceSummary,
} from "./model";
import { conversationPhase, historyFor, prepareProposal, proposalHash } from "./proposals";
import { Settings } from "./Settings";
import { TwinConversation } from "./TwinConversation";
import { useDictation } from "./useDictation";
import { useWorkspace } from "./useWorkspace";
import { Work } from "./Work";
import { WorkspaceContext } from "./WorkspaceContext";

export interface TwinIntent { id: string; workspaceId: string | null; text: string; target: TwinTarget }
type Editor =
  | { kind: "proposal"; proposal: TwinDraft }
  | { kind: "agent"; draft: AgentInput }
  | { kind: "automation"; draft: AutomationInput }
  | { kind: "settings"; draft: SettingsData }
  | { kind: "task"; task: Task }
  | { kind: "approval"; approval: Approval; recommendation?: string; reason: string };
const panelNames = { work: "Tasks & evidence", agents: "Agents", automations: "Routines", settings: "Workspace settings" };
export function WorkspaceSession({ client, workspace, workspaceId, online, connectionError, catalogLoading, intent, onExchange, onRefreshCatalog, onCreated }: {
  client: WorkClient; workspace: WorkspaceSummary | null; workspaceId: string | null; online: boolean;
  connectionError: string; catalogLoading: boolean; intent: TwinIntent | null;
  onExchange: (workspaceId: string | null, content: string, phase: string, revision: number) => void;
  onRefreshCatalog: () => Promise<void>; onCreated: (workspaceId: string) => Promise<void>;
}) {
  const state = useWorkspace(client, workspaceId, online);
  const { snapshot, conversation, status, providers, computer, diagnostics, connected, busy, perform, request, refresh } = state;
  const [text, setText] = useState("");
  const [target, setTarget] = useState<TwinTarget>("auto");
  const [pendingMessage, setPendingMessage] = useState("");
  const [lastProposal, setLastProposal] = useState<TwinDraft | null>(null);
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState("");
  const [panel, setPanel] = useState<Area | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [artifact, setArtifact] = useState<{ item: Artifact; content: string | null; error: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scrollEnd = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const artifactGeneration = useRef(0);
  const dictation = useDictation({
    enabled: connected && !busy && !editor && !panel && !statusOpen,
    onTranscript: (transcript) => setText((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${transcript}`),
  });
  const focusComposer = () => { requestAnimationFrame(() => composer.current?.focus()); };
  const askTwin = (message: string, requestedTarget: TwinTarget = "auto") => {
    dictation.cancel(); setPanel(null); setEditor(null); setStatusOpen(false); setText(message); setTarget(requestedTarget); setLocalError("");
    focusComposer();
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; artifactGeneration.current++; };
  }, []);
  useEffect(() => {
    if (intent?.workspaceId === workspaceId) {
      setText(intent.text); setTarget(intent.target);
      requestAnimationFrame(() => composer.current?.focus());
    }
  }, [intent, workspaceId]);
  useEffect(() => {
    if (!statusOpen || !window.matchMedia("(max-width: 1100px)").matches) return;
    const frame = requestAnimationFrame(() => {
      const context = document.getElementById("workspace-context");
      context?.scrollIntoView({ block: "start", behavior: "instant" });
      context?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [statusOpen]);
  useEffect(() => {
    const last = conversation?.turns.at(-1);
    if (last && conversation) onExchange(workspaceId, last.content, conversationPhase(conversation), conversation.revision);
  }, [conversation, onExchange, workspaceId]);
  useEffect(() => { scrollEnd.current?.scrollIntoView?.({ block: "end", behavior: "instant" }); }, [conversation?.turns.length, pendingMessage, lastProposal?.id]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const override = new URLSearchParams(window.location.search).get("scoutTheme");
      const preferred = snapshot?.settings.appearance.theme ?? "system";
      document.documentElement.dataset.theme = override === "light" || override === "dark" ? override
        : preferred === "system" ? media.matches ? "dark" : "light" : preferred;
      document.documentElement.dataset.density = snapshot?.settings.appearance.density ?? "comfortable";
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [snapshot?.settings.appearance.theme, snapshot?.settings.appearance.density]);
  const send = async () => {
    if (!connected || busy || dictation.active || !text.trim()) return;
    const input = twinMessageRequestSchema.safeParse({
      workspaceId, message: text.trim(), target, history: historyFor(conversation, text.trim()),
      ...(conversation ? { contextRevision: conversation.revision } : {}),
    });
    if (!input.success) { setLocalError("Keep your message under 8,000 characters. Your Twin can work through the rest in a follow-up."); return; }
    setLocalError(""); setPendingMessage(input.data.message);
    const result = await request("twin.message", input.data, "");
    if (!alive.current) return;
    setPendingMessage("");
    if (result && result.workspaceId === workspaceId) {
      setLastProposal(result); setText("");
      if (result.kind !== "clarification") setTarget("auto");
    }
    focusComposer();
  };
  const apply = async (proposal: TwinDraft, editedDraft?: object): Promise<boolean> => {
    const prepared = prepareProposal(proposal, workspaceId, snapshot);
    const hash = proposalHash(proposal);
    if (!prepared || prepared.kind === "approval" || !hash) {
      setLocalError("Ask your Twin to complete or refresh this proposal. Approval decisions must be made explicitly."); return false;
    }
    setLocalError("");
    const result = await request("twin.applyProposal", {
      workspaceId, id: proposal.id, proposalHash: hash, ...(editedDraft ? { editedDraft: { ...editedDraft } } : {}),
    }, "Proposal applied. Execution and verification are reported separately.");
    if (!result || !alive.current) return false;
    if (result.id !== proposal.id || result.kind !== prepared.kind) {
      setLocalError("The host returned a different proposal receipt. Refresh before taking another action."); return false;
    }
    setDispositions((current) => ({ ...current, [proposal.id]: "Applied" }));
    if (result.kind === "workspace") {
      const created = workspaceSummarySchema.safeParse(result.result);
      if (created.success) await onCreated(created.data.id);
      else await onRefreshCatalog();
    } else if (result.kind === "settings") await onRefreshCatalog();
    return true;
  };
  const dismiss = async (proposal: TwinDraft) => {
    const hash = proposalHash(proposal);
    if (!hash || proposal.workspaceId !== workspaceId) return;
    const result = await request("twin.dismissProposal", { workspaceId, id: proposal.id, proposalHash: hash, reason: "Dismissed by the owner." }, "Proposal dismissed. Nothing was created.");
    if (result && alive.current) setDispositions((current) => ({ ...current, [proposal.id]: "Dismissed" }));
  };
  const review = (proposal: TwinDraft) => {
    const prepared = prepareProposal(proposal, workspaceId, snapshot);
    if (!prepared) { setLocalError("This proposal is incomplete or no longer actionable. Ask your Twin for an updated draft."); return; }
    if (prepared.kind === "approval") {
      const approval = snapshot!.approvals.find((item) => item.id === prepared.input.approvalId)!;
      setEditor({ kind: "approval", approval, recommendation: prepared.input.recommendation, reason: prepared.input.reason });
    } else setEditor({ kind: "proposal", proposal });
  };
  const openArtifact = async (item: Artifact) => {
    if (workspaceId === null || !snapshot?.artifacts.some((record) => record.id === item.id && record.sha256 === item.sha256)) return;
    const current = ++artifactGeneration.current;
    setArtifact({ item, content: null, error: "" }); setArtifactLoading(true);
    try {
      const result = await client.call("artifacts.read", { workspaceId, id: item.id });
      if (!alive.current || current !== artifactGeneration.current) return;
      if (result.artifact.id !== item.id || result.artifact.workspaceId !== item.workspaceId || result.artifact.sha256 !== item.sha256)
        throw new Error("The artifact identity changed. Refresh before opening it.");
      setArtifact({ item: result.artifact, content: result.content, error: "" });
    } catch (error) {
      if (alive.current && current === artifactGeneration.current) setArtifact({ item, content: null, error: error instanceof Error ? error.message : "The artifact could not be loaded." });
    } finally { if (alive.current && current === artifactGeneration.current) setArtifactLoading(false); }
  };
  const disabled = !connected || busy;
  const error = localError || state.error || connectionError;
  const loading = state.loading || catalogLoading;
  const prepared = editor?.kind === "proposal" ? prepareProposal(editor.proposal, workspaceId, snapshot) : null;
  const reviewProps = { busy, error, onClose: () => setEditor(null) };
  const editorTitle = editor?.kind === "proposal" ? `Review ${editor.proposal.kind === "automation" ? "routine" : editor.proposal.kind} proposal`
    : editor?.kind === "approval" ? "Your approval decision" : `Review saved ${editor?.kind === "automation" ? "routine" : editor?.kind}`;
  const latestApproval = editor?.kind === "approval" ? snapshot?.approvals.find((item) => item.id === editor.approval.id) : null;
  return <>
    <main id="main-content" className="twin-main" tabIndex={-1} data-workspace-id={workspaceId ?? "concierge"}>
      <header className="twin-header"><div className="row"><span className="twin-header-mark" aria-hidden="true"><Icon name="chat" size={23} /></span><div className="min-zero"><p className="eyebrow">{workspace ? workspace.name : "Global concierge"}</p><h1>{workspace?.twin.name ?? "Your Work Twin"}</h1><p className="twin-subtitle">{workspace ? "A persistent conversation for this workspace." : "Turn an idea into a complete business workspace."}</p></div></div>
        <div className="row"><button className="icon-button" aria-label="Refresh workspace" disabled={busy || loading} onClick={() => { void refresh(); void onRefreshCatalog(); }}><Icon name="refresh" size={18} /></button><button className="icon-button context-toggle" aria-label="Toggle workspace status" aria-controls="workspace-context" aria-expanded={statusOpen} onClick={() => setStatusOpen(!statusOpen)}><Icon name="computer" size={19} /></button></div>
      </header>
      {workspace && <nav className="workspace-tools" aria-label="Workspace tools">{(["work", "agents", "automations", "settings"] as const).map((area) => <button key={area} onClick={() => setPanel(area)} disabled={!snapshot}><Icon name={area} size={15} />{area === "work" ? "Tasks" : area === "automations" ? "Routines" : area === "agents" ? "Agents" : "Settings"}</button>)}<span>Inspect here. Create with your Twin.</span></nav>}
      <div className="conversation-scroll">
        {error && !editor && <div className="message error-message" role="alert"><Icon name="shield" size={17} /><span>{error}</span><button className="text-button" onClick={() => { setLocalError(""); void refresh(); void onRefreshCatalog(); }}>Refresh</button></div>}
        {state.notice && !editor && <p className="message" role="status"><Icon name="check" size={16} />{state.notice}</p>}
        {!online && snapshot && <p className="inline-note">Showing this workspace's last loaded records. Changes are disabled until the host reconnects.</p>}
        {loading && <p role="status" aria-label="Loading workspace" className="inline-note">Loading this workspace's conversation…</p>}
        {!loading && !online && !conversation && <section className="conversation-welcome"><span className="welcome-mark" aria-hidden="true"><Icon name="chat" size={32} /></span><h2>Connect to your local host</h2><p>Open RAPP Work desktop to talk with your Twin. No sample conversations, agents, or computer results are loaded.</p><button className="button secondary" onClick={() => { void onRefreshCatalog(); }}>Try connecting again</button></section>}
        {!loading && connected && !conversation?.turns.length && !lastProposal && <section className="conversation-welcome"><span className="welcome-mark" aria-hidden="true"><Icon name="chat" size={32} /></span><p className="eyebrow">{workspace ? "Your workspace Twin" : "Meet your concierge Twin"}</p><h2>{workspace ? "What should we work on?" : "What would you like to run?"}</h2><p>{workspace ? workspace.purpose : "Describe your business, goal, or new idea. I'll draft the workspace, team, and first steps for your review."}</p><p className="welcome-promise">You bring the intent. Your Twin fills in the details.<br />Nothing is applied without your say.</p>
          <div className="intent-suggestions">{workspace ? <>
            <button onClick={() => askTwin("Create a task to ", "task")}><Icon name="work" size={17} />Plan a task</button>
            <button onClick={() => askTwin("Create an agent responsible for ", "agent")}><Icon name="agents" size={17} />Build your team</button>
            <button onClick={() => askTwin("Create a routine that ", "automation")}><Icon name="clock" size={17} />Set a routine</button>
          </> : <button onClick={() => askTwin("Create a workspace for ", "workspace")}><Icon name="plus" size={17} />Describe a new workspace</button>}</div>
        </section>}
        <TwinConversation conversation={conversation} workspaceId={workspaceId} snapshot={snapshot} lastProposal={lastProposal} pendingMessage={pendingMessage}
          busy={busy} connected={connected} dispositions={dispositions} onReview={review} onApply={(proposal) => { void apply(proposal); }} onDismiss={(proposal) => { void dismiss(proposal); }} onReply={focusComposer} />
        <div ref={scrollEnd} />
      </div>
      <div className="composer-container"><form className="twin-composer" aria-label="Message your Work Twin" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label htmlFor="twin-message" className="sr-only">Message your Work Twin</label>
        <textarea ref={composer} id="twin-message" value={text} onFocus={() => setStatusOpen(false)} onChange={(event) => { setText(event.target.value); setLocalError(""); }} maxLength={8000} rows={3} placeholder={workspace ? "Tell your Twin what you want to get done…" : "Describe the workspace you want to create…"} disabled={busy}
          aria-describedby="composer-help dictation-status" onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <div className="composer-controls"><div className="row"><button type="button" className={`icon-button microphone-button${dictation.active ? " listening" : ""}`}
          aria-label={dictation.active ? "Stop dictation" : "Start voice dictation"} aria-pressed={dictation.active}
          disabled={!dictation.available || !connected || busy || statusOpen} title={dictation.available ? "Dictate a message. Review the transcript before sending." : "Voice dictation is unavailable; type your message instead."} onClick={dictation.toggle}><Icon name={dictation.active ? "stop" : "microphone"} size={20} /></button><span className="composer-context">{target === "auto" ? "Talk to your Twin" : target === "automation" ? "Drafting a routine" : `Drafting ${target === "settings" ? "settings" : `a ${target}`}`}</span></div>
          <button className="button primary send-button" type="submit" disabled={disabled || !text.trim() || dictation.active || text.length > 8000}>{busy ? "Working…" : "Send"}<Icon name="arrow" size={17} /></button></div>
      </form>
        <div id="dictation-status" className={`dictation-status${dictation.state === "error" ? " dictation-error" : ""}`} role={dictation.state === "error" ? "alert" : "status"}>{dictation.detail}{dictation.interim && <span className="interim-transcript">Hearing: {dictation.interim} (not final)</span>}</div>
        <p id="composer-help" className="composer-help">Enter to send · Shift+Enter for a new line · {dictation.available ? "Voice uses your browser's speech service, which may process audio online. Only while listening." : "Text is always available."}</p>
      </div>
    </main>
    <WorkspaceContext workspace={workspace} snapshot={snapshot} computer={computer} providers={providers} open={statusOpen} connected={connected} busy={busy} inspect={setPanel} askTwin={askTwin}
      onReturn={() => { setStatusOpen(false); focusComposer(); }} />
    {panel && snapshot && <Modal title={panelNames[panel]} wide onClose={() => setPanel(null)}>
      {panel !== "settings" && <div className="inspector-intent"><p>Review existing work here. Your Twin drafts anything new.</p><button className="button primary" disabled={disabled} onClick={() => askTwin(panel === "work" ? "Create a task to " : panel === "agents" ? "Create an agent responsible for " : "Create a routine that ", panel === "work" ? "task" : panel === "agents" ? "agent" : "automation")}>New {panel === "work" ? "task" : panel === "agents" ? "agent" : "routine"} with Twin</button></div>}
      {panel === "work" && <Work snapshot={snapshot} status={status} computer={computer} connected={connected} busy={busy} perform={perform}
        newTask={() => askTwin("Create a task to ", "task")} askTwin={askTwin} reviewTask={(task) => setEditor({ kind: "task", task })}
        review={(approval) => setEditor({ kind: "approval", approval, reason: approval.decisionReason || approval.reason })} openArtifact={(item) => { void openArtifact(item); }} />}
      {panel === "agents" && <Agents snapshot={snapshot} providers={providers} connected={connected} create={() => askTwin("Create an agent responsible for ", "agent")} edit={(agent) => setEditor({ kind: "agent", draft: agentInputSchema.strip().parse(agent) })} />}
      {panel === "automations" && <Automations snapshot={snapshot} connected={connected} create={() => askTwin("Create a routine that ", "automation")} edit={(automation) => setEditor({ kind: "automation", draft: automationInputSchema.strip().parse(automation) })} />}
      {panel === "settings" && <Settings snapshot={snapshot} status={status} providers={providers} computer={computer} diagnostics={diagnostics} connected={connected} busy={busy} refresh={refresh} askTwin={(message) => askTwin(message, "settings")} edit={() => setEditor({ kind: "settings", draft: snapshot.settings })} />}
    </Modal>}
    {editor && <Modal title={editorTitle} onClose={() => setEditor(null)} busy={busy}>
      {!connected && <p className="inline-note">Reconnect before applying changes. You can close this review without saving.</p>}
      <fieldset className="review-fields" disabled={!connected}>
      {editor.kind === "proposal" && prepared && (() => {
        const common = { ...reviewProps, source: "twin" as const };
        const save = (input: object) => apply(editor.proposal, input);
        switch (prepared.kind) {
          case "workspace": return <WorkspaceForm {...common} draft={prepared.input} onSave={save} />;
          case "task": return <TaskForm {...common} draft={prepared.input} agents={snapshot?.agents ?? []} onSave={save} />;
          case "agent": return <AgentForm {...common} draft={prepared.input} providers={providers} onSave={save} />;
          case "automation": return <AutomationForm {...common} draft={prepared.input} agents={snapshot?.agents ?? []} onSave={save} />;
          case "settings": return <SettingsForm {...common} draft={prepared.input} onSave={save} />;
          default: return null;
        }
      })()}
      {editor.kind === "proposal" && !prepared && <p className="form-body" role="alert">This proposal is no longer actionable. Close this review and ask your Twin to refresh it.</p>}
      {editor.kind === "agent" && workspaceId !== null && <AgentForm {...reviewProps} source="existing" draft={editor.draft} providers={providers} onSave={(input) => perform("agents.save", { ...input, workspaceId }, "Agent changes saved.")} />}
      {editor.kind === "task" && workspaceId !== null && snapshot && <SavedTaskForm {...reviewProps}
        task={snapshot.tasks.find((item) => item.id === editor.task.id) ?? editor.task} agents={snapshot.agents}
        assignable={["queued", "failed", "cancelled"].includes(editor.task.state) && !snapshot.runs.some((run) => run.taskId === editor.task.id)}
        onAssign={(agentId) => perform("work.assignTask", { workspaceId, id: editor.task.id, agentId }, "Task assignment saved.")} />}
      {editor.kind === "automation" && workspaceId !== null && <AutomationForm {...reviewProps} source="existing" draft={editor.draft} agents={snapshot?.agents ?? []} onSave={(input) => perform("automations.save", { ...input, workspaceId }, "Routine changes saved.")} />}
      {editor.kind === "settings" && workspaceId !== null && <SettingsForm {...reviewProps} source="existing" draft={editor.draft} onSave={async (settings) => {
        const saved = await perform("settings.update", { ...settings, workspaceId }, "Settings changes saved."); if (saved) await onRefreshCatalog(); return saved;
      }} />}
      {editor.kind === "approval" && workspaceId !== null && <ApprovalForm {...reviewProps} approval={latestApproval ?? editor.approval} recommendation={editor.recommendation} initialReason={editor.reason} onDecide={(decision, reason) => {
        if (!latestApproval || latestApproval.operationHash !== editor.approval.operationHash || latestApproval.state !== "pending"
          || latestApproval.consumedBy || new Date(latestApproval.expiresAt).getTime() <= Date.now()
          || !snapshot?.runs.some((run) => run.id === latestApproval.runId && run.state === "awaiting_approval")) {
          setLocalError("This approval changed or expired. Refresh before deciding."); return Promise.resolve(false);
        }
        return perform("approvals.decide", { workspaceId, id: editor.approval.id, decision, reason }, "Your explicit decision was recorded. Execution is reported separately.");
      }} />}
      </fieldset>
    </Modal>}
    {artifact && <Modal title={artifact.item.name} onClose={() => { artifactGeneration.current++; setArtifact(null); }} busy={artifactLoading}>
      <div className="form-body"><Badge>{artifact.item.evidence ? "Service-reported evidence" : "Artifact"}</Badge><p className="small-text mono hash">SHA-256 · {artifact.item.sha256}</p>
        {artifactLoading && <p role="status">Loading artifact…</p>}{artifact.error && <p className="form-error" role="alert">{artifact.error}</p>}
        {artifact.content !== null && <pre className="artifact-content" tabIndex={0} aria-label="Artifact content">{artifact.content}</pre>}
      </div><footer className="form-footer"><button className="button secondary" disabled={artifactLoading} onClick={() => { artifactGeneration.current++; setArtifact(null); }}>Close artifact</button></footer>
    </Modal>}
  </>;
}

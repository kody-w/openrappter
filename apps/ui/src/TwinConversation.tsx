import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, Icon, formatDate } from "./components";
import { MAX_INSTRUCTION_CHARS, type Agent, type TwinConversation as Conversation, type TwinDraft, type TwinMessageRequest } from "./model";

export interface IntentSeed { id: number; workspaceId: string | null; target: TwinMessageRequest["target"]; message: string }
export function TwinConversation({ workspaceId, name, conversation, connected, busy, seed, send, review, dismiss, agents, openAgent }: {
  workspaceId: string | null; name: string; conversation: Conversation | null; connected: boolean; busy: boolean;
  seed: IntentSeed | null; send: (message: string, target: TwinMessageRequest["target"]) => Promise<TwinDraft | undefined>;
  review: (proposal: TwinDraft) => void; dismiss: (proposal: TwinDraft) => void;
  agents: Agent[]; openAgent: (agent: Agent) => void;
}) {
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<TwinMessageRequest["target"]>(workspaceId === null ? "workspace" : "auto");
  const oversized = message.length > MAX_INSTRUCTION_CHARS || new TextEncoder().encode(message).byteLength > 128 * 1024;
  const input = useRef<HTMLTextAreaElement>(null);
  const appliedSeed = useRef<number | null>(null);
  useEffect(() => {
    if (!connected || seed?.workspaceId !== workspaceId || appliedSeed.current === seed.id) return;
    appliedSeed.current = seed.id;
    setMessage(seed.message); setTarget(seed.target); input.current?.focus();
  }, [seed, workspaceId, connected]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || oversized) return;
    const response = await send(message, target);
    if (response) setMessage("");
  };
  const proposals = new Map(conversation?.proposals.map((proposal) => [proposal.id, proposal]) ?? []);
  const stateOf = (id: string) => [...(conversation?.events ?? [])].reverse().find((event) =>
    event.proposalId === id && ["accept", "dismiss"].includes(event.kind))?.kind;
  return <section className="twin-conversation" aria-label="Twin conversation">
    <header className="twin-heading"><div><p className="eyebrow">Conversation first</p><h2>{name}</h2></div><Badge>Required: Astra · max · long</Badge></header>
    <p className="twin-guidance">Describe an outcome or paste a complete Markdown instruction document. Your Twin fills out the draft; you review it, not a blank form.</p>
    <div className="conversation-turns" aria-live="polite" aria-relevant="additions" aria-label="Conversation history">
      {!conversation?.turns.length && <div className="conversation-welcome"><Icon name="document" size={28} />
        <h3>{workspaceId === null ? "What business should we build a workspace for?" : "What would you like to get done?"}</h3>
        <p>No fields to re-enter. Paste instructions as-is, including restrictions and locked evidence phrases.</p></div>}
      {conversation?.turns.map((turn) => {
        const proposal = turn.proposalId ? proposals.get(turn.proposalId) : undefined;
        const status = proposal ? stateOf(proposal.id) : undefined;
        const verification = !connected ? "unavailable" : proposal?.basis?.verification?.state ?? "unverified";
        return <article className={`conversation-turn ${turn.role}`} key={turn.id}>
          <div className="row between"><strong>{turn.role === "user" ? "You" : name}</strong><time dateTime={turn.createdAt}>{formatDate(turn.createdAt)}</time></div>
          <div className={`turn-content preserve${turn.content.length > 4000 ? " long-document" : ""}`} tabIndex={turn.content.length > 4000 ? 0 : undefined}>{turn.content}</div>
          {turn.role === "assistant" && agents.some((agent) => turn.content.includes(agent.name)) && <div className="row wrap" aria-label="Agent workspaces mentioned">
            {agents.filter((agent) => turn.content.includes(agent.name)).map((agent) => <button key={agent.id} className="text-button"
              disabled={!connected} onClick={() => openAgent(agent)}>Open {agent.name}'s workspace</button>)}
          </div>}
          {proposal && <div className="proposal-card" data-proposal-id={proposal.id}>
            <div className="row between"><Badge>{proposal.kind === "clarification" ? "Necessary follow-up" : proposal.kind === "approval" ? "Recommendation only" : "Complete draft"}</Badge>
              {status && <Badge tone={status === "accept" ? "positive" : "neutral"}>{status === "accept" ? "Applied" : "Dismissed"}</Badge>}</div>
            <p>{proposal.summary}</p>
            <p className="small-text">{verification === "verified" ? "Verified local integrity — not factual truth, authorship or promotion-grade trust."
              : verification === "unavailable" ? "Verification unavailable. Reconnect and scan the proposal before review." : "Unverified proposal. A canonical source/evidence scan is required."}</p>
            {proposal.basis?.instructionDocument && <p className="small-text">Full instruction document preserved verbatim.</p>}
            {proposal.kind === "clarification" ? <p className="small-text">Still needed: {proposal.missing.join(", ")}</p> :
              !status && <div className="row wrap">
                <button className="button primary" disabled={!connected || busy || verification !== "verified"} onClick={() => review(proposal)}>
                  {proposal.kind === "approval" ? "Review approval decision" : "Review complete draft"}<Icon name="arrow" size={16} />
                </button><button className="text-button" disabled={!connected || busy} onClick={() => dismiss(proposal)}>Dismiss draft</button>
              </div>}
          </div>}
        </article>;
      })}
    </div>
    <form className="twin-composer" aria-label="Message the Twin" onSubmit={(event) => { void submit(event); }}>
      <label htmlFor="twin-message">Your intent or full instruction document</label>
      <textarea id="twin-message" ref={input} value={message} disabled={!connected || busy} onChange={(event) => setMessage(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text/plain");
          event.preventDefault();
          const field = event.currentTarget;
          setMessage(message.slice(0, field.selectionStart) + pasted + message.slice(field.selectionEnd));
        }} rows={5} placeholder={workspaceId === null
          ? "Create a workspace for my business…" : "# Inventory Visibility Agent — Manual Global Instructions\nPaste your complete instructions, or describe what you need…"} />
      {oversized && <p role="alert">This document exceeds 64,000 characters or 128 KiB. Nothing was truncated or submitted.</p>}
      <div className="row between wrap"><span className="field-help">Up to 64,000 characters. Pasted instructions are not trimmed or summarized.</span>
        <button className="button primary" type="submit" disabled={!connected || busy || !message.trim() || oversized}><Icon name="arrow" size={16} />{busy ? "Waiting for the host…" : "Send intent"}</button></div>
    </form>
  </section>;
}

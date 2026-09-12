import { useState } from "react";
import { Badge, Empty, formatDate, Icon, StatusBadge, TabPanel, Tabs } from "./components";
import { serviceNames, type Computer, type Diagnostics, type Provider, type Snapshot, type Status } from "./model";

type SettingsTab = "general" | "providers" | "safety" | "diagnostics";
interface Props {
  snapshot: Snapshot; status: Status | null; providers: Provider[]; diagnostics: Diagnostics | null;
  computer: Computer | null; connected: boolean; busy: boolean; refresh: () => Promise<void>;
  edit: () => void; askTwin: (message: string) => void;
}
export function Settings({ snapshot, status, providers, diagnostics, computer, connected, busy, refresh, edit, askTwin }: Props) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [copied, setCopied] = useState("");
  const settings = snapshot.settings;
  return <section className="workspace-panel">
    <Tabs label="Settings views" selected={tab} onChange={setTab} tabs={[
      { id: "general", label: "General" }, { id: "providers", label: "Providers" },
      { id: "safety", label: "Safety & access" }, { id: "diagnostics", label: "Diagnostics" },
    ]} />
    <TabPanel id={tab}>
      {tab === "general" && <div className="settings-content">
        <div className="section-header flush"><div><h2>Workspace preferences</h2><p className="muted">Tell your Twin what should change. These are the currently saved values.</p></div></div>
        <dl className="metadata">
          <div><dt>Workspace</dt><dd>{settings.workspaceName}</dd></div>
          <div><dt>Theme</dt><dd>{settings.appearance.theme}</dd></div>
          <div><dt>Density</dt><dd>{settings.appearance.density}</dd></div>
          <div><dt>Task priority</dt><dd>{settings.work.defaultPriority}</dd></div>
          <div><dt>Approval alerts</dt><dd>{settings.notifications.approvals ? "On" : "Off"}</dd></div>
          <div><dt>Run alerts</dt><dd>{settings.notifications.completedRuns ? "On" : "Off"}</dd></div>
        </dl>
        <div className="row wrap">
          <button className="button primary" disabled={!connected || busy} onClick={() => askTwin("Change this workspace's settings to ")}>Change settings with Twin</button>
          <button className="button secondary" disabled={!connected || busy} onClick={edit}>Review saved settings</button>
        </div>
      </div>}
      {tab === "providers" && <div className="settings-content">
        <div className="section-header flush"><div><h2>Provider connections</h2><p className="muted">Authentication and models are reported by the local runtime. Credentials never belong in chat.</p></div><button className="button secondary" disabled={!connected || busy} onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />Refresh providers</button></div>
        {!providers.length ? <Empty icon="settings" title="No provider status available">The Twin can help identify setup requirements. No model connection is assumed.</Empty> :
          <div className="stack">{providers.map((provider) => <article className="provider-card" key={provider.id}>
            <div className="row between"><h3>{provider.name}</h3><Badge tone={provider.configured ? "positive" : "neutral"}>{provider.configured ? "Connected" : "Needs setup"}</Badge></div>
            <p className="muted">{provider.detail}</p><p className="small-text">{provider.models.length ? provider.models.join(" · ") : "No models reported"}</p>
            <p className="small-text">Runtime: {provider.availability} · Authentication: {provider.authentication}</p>
            <button className="text-button" disabled={!connected || busy} onClick={() => askTwin(`Help me configure ${provider.name} using a secure connection reference, without sharing credentials.`)}>Ask Twin about this connection<Icon name="arrow" size={16} /></button>
          </article>)}</div>}
      </div>}
      {tab === "safety" && <div className="settings-content">
        <div className="policy-banner"><Icon name="shield" size={28} /><div><h2>Explicit access. Human decisions.</h2><p>Your Twin can recommend, but only you can approve or deny a sensitive action. Policies stay attached to this workspace.</p></div></div>
        <dl className="metadata"><div><dt>Require approval</dt><dd>{settings.work.approvalPolicy === "always" ? "For all actions" : "For sensitive actions"}</dd></div></dl>
        <div className="row wrap"><button className="button primary" disabled={!connected || busy} onClick={() => askTwin("Change this workspace's approval policy to ")}>Discuss policy with Twin</button><button className="button secondary" disabled={!connected || busy} onClick={edit}>Review saved policy</button></div>
        <p className="inline-note">Workspace and agent access policies both apply. Completion, computer availability, and verified evidence are separate service assertions.</p>
      </div>}
      {tab === "diagnostics" && <div className="settings-content">
        <div className="section-header flush"><div><h2>Workspace diagnostics</h2><p className="muted">Live service reports, without credentials.</p></div><div className="row wrap">
          <button className="button secondary" disabled={!connected || busy} onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />Refresh diagnostics</button>
          <button className="button secondary" disabled={!status} onClick={() => {
            void navigator.clipboard.writeText(JSON.stringify({ workspaceId: snapshot.workspaceId, status, computer, diagnostics }, null, 2))
              .then(() => setCopied("Diagnostic report copied.")).catch(() => setCopied("Clipboard access was not available."));
          }}>Copy report</button>
        </div></div>
        {copied && <p role="status" className="inline-note">{copied}</p>}
        {!status ? <Empty icon="settings" title="No live service report">Reconnect to the desktop host to inspect service readiness.</Empty> : <ul className="service-list">{serviceNames.map((name) => <li key={name}>
          <div><h3>{name.charAt(0).toUpperCase() + name.slice(1)}</h3><p className="muted small-text">{status.checks[name].detail}</p></div><StatusBadge state={status.checks[name].state} />
        </li>)}</ul>}
        <h3 className="section-label">Recent host diagnostics</h3><p className="muted small-text">Captured {formatDate(diagnostics?.capturedAt ?? null)}</p>
        {!diagnostics?.entries.length ? <p className="inline-note">No diagnostic entries have been reported.</p> :
          <ul className="diagnostic-log">{diagnostics.entries.map((entry) => <li key={entry.id}><Badge tone={entry.level === "error" ? "danger" : "neutral"}>{entry.level}</Badge><p>{entry.message}</p><time dateTime={entry.time}>{formatDate(entry.time)}</time></li>)}</ul>}
      </div>}
    </TabPanel>
  </section>;
}

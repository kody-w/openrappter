import { useState } from "react";
import { Badge, Empty, Icon, StatusBadge, TabPanel, Tabs } from "./components";
import { serviceNames, type Computer, type Diagnostics, type Provider, type Snapshot, type Status } from "./model";
import type { Perform } from "./useWorkspace";

export function Settings({ snapshot, status, providers, diagnostics, computer, connected, busy, perform, refresh, discuss }: {
  snapshot: Snapshot; status: Status | null; providers: Provider[]; diagnostics: Diagnostics | null; computer: Computer | null;
  connected: boolean; busy: boolean; perform: Perform; refresh: () => Promise<void>; discuss: () => void;
}) {
  const [tab, setTab] = useState<"general" | "providers" | "safety" | "diagnostics">("general");
  const [copied, setCopied] = useState("");
  const settings = snapshot.settings;
  return <section className="workspace-panel">
    <Tabs label="Settings views" selected={tab} onChange={setTab} tabs={[
      { id: "general", label: "General" }, { id: "providers", label: "Providers" },
      { id: "safety", label: "Safety & access" }, { id: "diagnostics", label: "Diagnostics" },
    ]} />
    <TabPanel id={tab}><div className="settings-content">
      {(tab === "general" || tab === "safety") && <>
        <h2>{tab === "general" ? "Current workspace settings" : "Explicit access and approvals"}</h2>
        <p className="muted">Describe a change to the Twin. Review a complete settings draft before applying it.</p>
        <dl className="metadata">
          <div><dt>Workspace</dt><dd>{settings.workspaceName}</dd></div>
          <div><dt>Theme</dt><dd>{settings.appearance.theme}</dd></div><div><dt>Density</dt><dd>{settings.appearance.density}</dd></div>
          <div><dt>Default priority</dt><dd>{settings.work.defaultPriority}</dd></div>
          <div><dt>Approval policy</dt><dd>{settings.work.approvalPolicy === "always" ? "Always require approval" : "Require approval for sensitive actions"}</dd></div>
          <div><dt>Approval notices</dt><dd>{settings.notifications.approvals ? "Enabled" : "Disabled"}</dd></div>
          <div><dt>Completed-run notices</dt><dd>{settings.notifications.completedRuns ? "Enabled" : "Disabled"}</dd></div>
        </dl><button className="button primary" disabled={!connected || busy} onClick={discuss}>Discuss workspace settings</button>
        <p className="inline-note">Starting a computer does not override agent restrictions. No provider tools run on the host; approvals remain exact and scoped.</p>
      </>}
      {tab === "providers" && <>
        <h2>Verified provider connections</h2><p className="muted">Credentials stay outside the renderer. Astra max/long context is required for Twin drafts.</p>
        {!providers.length ? <Empty icon="settings" title="No provider status available">Reconnect to the local host.</Empty> :
          providers.map((provider) => <article className="provider-card" key={provider.id}>
            <div className="row between"><h3>{provider.name}</h3><Badge>{provider.configured ? "Connected" : "Unavailable for drafting"}</Badge></div>
            <p>{provider.detail}</p><p className="small-text">{provider.models.join(" · ") || "No models reported"}</p>
            <p className="small-text">Authentication: {provider.authentication}</p>
            {provider.id === "github-copilot" && <button className="button secondary" disabled={!connected || busy}
              onClick={() => { void perform("providers.configure", { id: provider.id, connectionRef: "copilot-cli" }, "Verified Copilot connection reference recorded."); }}>Use verified Copilot CLI connection</button>}
          </article>)}
      </>}
      {tab === "diagnostics" && <>
        <div className="section-header flush"><h2>Workspace diagnostics</h2><button className="button secondary" disabled={!connected || busy}
          onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />Refresh diagnostics</button></div>
        {status ? <ul className="service-list">{serviceNames.map((name) => <li key={name}><div><h3>{name.charAt(0).toUpperCase() + name.slice(1)}</h3>
          <p>{status.checks[name].detail}</p></div><StatusBadge state={status.checks[name].state} /></li>)}</ul> : <p>No live diagnostics available.</p>}
        <button className="button secondary" disabled={!status} onClick={() => {
          void navigator.clipboard.writeText(JSON.stringify({ status, computer, diagnostics }, null, 2))
            .then(() => setCopied("Diagnostic report copied.")).catch(() => setCopied("Clipboard access was not available."));
        }}>Copy report</button>
        {copied && <p role="status">{copied}</p>}
      </>}
    </div></TabPanel>
  </section>;
}

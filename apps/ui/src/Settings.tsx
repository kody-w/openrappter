import { useState, type FormEvent } from "react";
import { Badge, Empty, Field, formatDate, Icon, StatusBadge, TabPanel, Tabs } from "./components";
import { serviceNames, type Computer, type Diagnostics, type Provider, type Settings as SettingsData, type Snapshot, type Status } from "./model";
import type { Perform } from "./useWorkspace";

type SettingsTab = "general" | "providers" | "safety" | "diagnostics";
interface Props {
  snapshot: Snapshot; status: Status | null; providers: Provider[]; diagnostics: Diagnostics | null;
  computer: Computer | null; connected: boolean; busy: boolean; perform: Perform; refresh: () => Promise<void>;
}
export function Settings({ snapshot, status, providers, diagnostics, computer, connected, busy, perform, refresh }: Props) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [copied, setCopied] = useState("");
  const settings = snapshot.settings;
  const saveGeneral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform("settings.update", {
      ...settings, workspaceName: String(form.get("workspaceName")),
      appearance: {
        theme: form.get("theme") as SettingsData["appearance"]["theme"],
        density: form.get("density") as SettingsData["appearance"]["density"],
      },
      work: { ...settings.work, defaultPriority: form.get("defaultPriority") === "high" ? "high" : "normal" },
      notifications: { approvals: form.has("approvals"), completedRuns: form.has("completedRuns") },
    }, "Workspace preferences saved.");
  };
  return <section className="workspace-panel">
    <Tabs label="Settings views" selected={tab} onChange={setTab} tabs={[
      { id: "general", label: "General" }, { id: "providers", label: "Providers" },
      { id: "safety", label: "Safety & access" }, { id: "diagnostics", label: "Diagnostics" },
    ]} />
    <TabPanel id={tab}>
      {tab === "general" && <form className="settings-form" key={JSON.stringify(settings)} onSubmit={(event) => { void saveGeneral(event); }}>
        <div className="settings-section"><div><h2>Workspace</h2><p>Preferences are saved in this local workspace.</p></div><div className="stack">
          <Field id="settings-name" label="Workspace name"><input id="settings-name" name="workspaceName" defaultValue={settings.workspaceName} required maxLength={160} /></Field>
          <Field id="settings-priority" label="Default task priority"><select id="settings-priority" name="defaultPriority" defaultValue={settings.work.defaultPriority}><option value="normal">Normal</option><option value="high">High</option></select></Field>
        </div></div>
        <div className="settings-section"><div><h2>Appearance</h2><p>A comfortable workspace, in either light or dark.</p></div><div className="form-grid">
          <Field id="settings-theme" label="Theme"><select id="settings-theme" name="theme" defaultValue={settings.appearance.theme}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
          <Field id="settings-density" label="Density"><select id="settings-density" name="density" defaultValue={settings.appearance.density}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Field>
        </div></div>
        <div className="settings-section"><div><h2>In-app notifications</h2><p>Choose which work updates are announced in the workspace.</p></div><div className="stack">
          <label className="checkbox-row"><input type="checkbox" name="approvals" defaultChecked={settings.notifications.approvals} />New approval requests</label>
          <label className="checkbox-row"><input type="checkbox" name="completedRuns" defaultChecked={settings.notifications.completedRuns} />Completed runs</label>
        </div></div>
        <div className="settings-footer"><button className="button primary" type="submit" disabled={busy || !connected}>{busy ? "Saving…" : "Save preferences"}</button></div>
      </form>}
      {tab === "providers" && <div className="settings-content">
        <div className="section-header flush"><div><h2>Provider connections</h2><p className="muted">Provider readiness is reported by the injected provider service.</p></div><button className="button secondary" disabled={!connected || busy} onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />Refresh providers</button></div>
        {!providers.length ? <Empty icon="settings" title="No provider service connected">A provider adapter must be installed in the host composition before models are available. Credentials stay outside the renderer; only secure connection references are accepted here.</Empty> :
          <div className="stack">{providers.map((provider) => <article className="provider-card" key={provider.id}>
            <div className="row between"><h3>{provider.name}</h3><Badge tone={provider.configured ? "positive" : "neutral"}>{provider.configured ? "Connected" : "Needs setup"}</Badge></div>
            <p className="muted">{provider.detail}</p><p className="small-text">{provider.models.length ? provider.models.join(" · ") : "No models reported"}</p>
            <form className="provider-form" onSubmit={(event) => {
              event.preventDefault();
              const connectionRef = String(new FormData(event.currentTarget).get("connectionRef"));
              void perform("providers.configure", { id: provider.id, connectionRef }, "Provider connection response received.");
            }}><Field id={`provider-${provider.id}`} label="Secure connection reference" help="Use a reference managed by the provider service, never an API key.">
                <input id={`provider-${provider.id}`} name="connectionRef" required maxLength={160} aria-describedby={`provider-${provider.id}-help`} placeholder="connections/your-provider" autoComplete="off" />
              </Field><button className="button secondary" disabled={busy || !connected}>Connect reference</button></form>
          </article>)}</div>}
      </div>}
      {tab === "safety" && <div className="settings-content">
        <div className="policy-banner"><Icon name="shield" size={28} /><div><h2>Explicit access. Deliberate approvals.</h2><p>Agents receive only the computer access in their configuration. Sensitive actions and decisions remain attached to the run that requested them.</p></div></div>
        <form className="settings-section" onSubmit={(event) => {
          event.preventDefault();
          const approvalPolicy = new FormData(event.currentTarget).get("approvalPolicy") as SettingsData["work"]["approvalPolicy"];
          void perform("settings.update", { ...settings, work: { ...settings.work, approvalPolicy } }, "Workspace approval policy saved.");
        }}><div><h3>Workspace approval policy</h3><p>The stricter workspace or agent policy applies to execution.</p></div><div className="stack">
          <Field id="safety-policy" label="Require approval"><select id="safety-policy" name="approvalPolicy" defaultValue={settings.work.approvalPolicy}><option value="always">For all actions</option><option value="on-risk">For sensitive actions</option></select></Field>
          <button className="button primary fit" disabled={busy || !connected}>Save approval policy</button>
        </div></form>
        <div className="policy-grid"><article><Icon name="work" /><h3>Workspace scoped</h3><p>Work and events belong to the authenticated workspace. Cursors cannot be reused across identities or scopes.</p></article><article><Icon name="computer" /><h3>Computer access is opt-in</h3><p>No desktop control is enabled by default. A connected service must report its available capabilities.</p></article><article><Icon name="document" /><h3>Evidence is explicit</h3><p>Completion and verification are separate. A verification claim must include service-reported evidence.</p></article></div>
      </div>}
      {tab === "diagnostics" && <div className="settings-content">
        <div className="section-header flush"><div><h2>Workspace diagnostics</h2><p className="muted">Live service reports, without request contents or credentials.</p></div><div className="row wrap">
          <button className="button secondary" disabled={!connected || busy} onClick={() => { void refresh(); }}><Icon name="refresh" size={16} />Refresh diagnostics</button>
          <button className="button secondary" disabled={!status} onClick={() => {
            void navigator.clipboard.writeText(JSON.stringify({ status, computer, diagnostics }, null, 2))
              .then(() => setCopied("Diagnostic report copied.")).catch(() => setCopied("Clipboard access was not available."));
          }}>Copy report</button>
        </div></div>
        {copied && <p role="status" className="inline-note">{copied}</p>}
        <div className="diagnostic-summary"><div><span className="eyebrow">Application protocol</span><p className="strong">{status ? `RAPP Work · version ${status.protocolVersion}` : "Not connected"}</p></div><div><span className="eyebrow">Overall readiness</span><p><StatusBadge state={status?.ready ? "ready" : "unavailable"} /></p></div></div>
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

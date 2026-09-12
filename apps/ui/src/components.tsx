import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type IconName = "work" | "agents" | "automations" | "settings" | "plus" | "arrow" | "check" | "clock" | "document" | "computer" | "shield" | "close" | "refresh" | "menu" | "search";
const paths: Record<IconName, ReactNode> = {
  work: <><rect x="3" y="6" width="18" height="15" rx="2" /><path d="M8 6V3h8v3M3 11h18M10 11v3h4v-3" /></>,
  agents: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" /></>,
  automations: <><path d="M14 2 4 14h7l-1 8 10-12h-7z" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14M14 7l5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  document: <><path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h6" /></>,
  computer: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  shield: <><path d="m12 2 8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5z" /><path d="m8 11 3 3 5-6" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M20 7V2l-3 3A9 9 0 0 0 3 11M4 17v5l3-3a9 9 0 0 0 14-6M20 2v5h-5M4 22v-5h5" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "positive" | "attention" | "danger" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function StatusBadge({ state }: { state: string }) {
  const labels: Record<string, string> = {
    awaiting_approval: "Needs approval", not_checked: "Not verified", ready: "Ready", queued: "Queued",
    running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", unavailable: "Not connected",
    degraded: "Needs attention", stopped: "Stopped", starting: "Starting", error: "Unavailable", pending: "Pending",
    approved: "Approved", denied: "Denied", passed: "Verified",
  };
  const positive = ["ready", "completed", "approved", "passed"].includes(state);
  const danger = ["failed", "error", "denied"].includes(state);
  const attention = ["awaiting_approval", "pending", "degraded"].includes(state);
  return <Badge tone={positive ? "positive" : danger ? "danger" : attention ? "attention" : "neutral"}>{labels[state] ?? state}</Badge>;
}
export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state">
    <span className="empty-icon"><Icon name={icon} size={28} /></span>
    <h3>{title}</h3><p>{children}</p>{action}
  </div>;
}
export function Tabs<T extends string>({ label, selected, tabs, onChange }: {
  label: string; selected: T; tabs: { id: T; label: string; count?: number }[]; onChange: (tab: T) => void;
}) {
  const key = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
  };
  return <div className="tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.id} id={`tab-${tab.id}`} role="tab" aria-label={`${tab.label}${tab.count === undefined ? "" : ` ${tab.count}`}`}
      aria-selected={selected === tab.id} aria-controls={selected === tab.id ? `panel-${tab.id}` : undefined} tabIndex={selected === tab.id ? 0 : -1}
      onClick={() => onChange(tab.id)} onKeyDown={(event) => key(event, index)}>
      {tab.label}{tab.count !== undefined && <span className="count">{tab.count}</span>}
    </button>)}
  </div>;
}
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return <section role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="tab-panel">{children}</section>;
}
export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    (element.querySelector<HTMLElement>("[data-autofocus]") ??
      element.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled])"))?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
      )];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose} disabled={busy}><Icon name="close" /></button>
    </header>{children}
  </dialog>;
}
export function Field({ label, id, help, children }: { label: string; id: string; help?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{help && <p className="field-help" id={`${id}-help`}>{help}</p>}</div>;
}
export function FormFooter({ busy, label = "Save changes", onClose }: { busy: boolean; label?: string; onClose: () => void }) {
  return <footer className="form-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
    <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving…" : label}</button></footer>;
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return <span className={`avatar${small ? " small" : ""}`} aria-hidden="true">{name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>;
}
export const formatDate = (date: string | null) => date ? new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date(date)) : "Not reported";

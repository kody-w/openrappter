import { css } from 'lit';

export const workStyles = css`
  :host {
    display: block;
    color: var(--cp-text);
    font-family: "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { box-sizing: border-box; }
  h1, h2, h3, p { margin: 0; }
  button, a { -webkit-tap-highlight-color: var(--cp-highlight); }
  button { font: inherit; cursor: pointer; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button:focus-visible, a:focus-visible, summary:focus-visible {
    outline: 2px solid var(--cp-accent); outline-offset: 4px;
  }
  .work { max-width: 1880px; margin: 0 auto; padding: 28px; }
  .hero { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
  .eyebrow { color: var(--cp-text-muted); font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .hero h1 { margin: 8px 0; font-size: clamp(24px, 2.5vw, 34px); line-height: 1.16; letter-spacing: -.035em; font-weight: 650; }
  .hero p, .muted { color: var(--cp-text-muted); font-size: 13px; line-height: 1.6; }
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 9px 13px; border: 1px solid var(--cp-border); border-radius: .625rem;
    background: var(--cp-surface); color: var(--cp-text); font-size: 12px; font-weight: 600;
    text-decoration: none; line-height: 1.3;
  }
  .button:hover:not(:disabled) { background: var(--cp-surface-soft); border-color: var(--cp-border-strong); }
  .button.primary { color: var(--cp-accent-fg); background: var(--cp-accent); border-color: var(--cp-accent); }
  .button.primary:hover:not(:disabled) { background: var(--cp-accent-hover); }
  .button.small { font-size: 11px; padding: 7px 10px; }
  .text-button { border: 0; padding: 4px 0; color: var(--cp-accent); background: var(--cp-accent-soft); font-size: 12px; border-radius: 4px; }
  .summary { display: flex; gap: 24px; padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--cp-border); }
  .summary-item { display: flex; align-items: baseline; gap: 8px; }
  .summary-item strong { font-size: 22px; letter-spacing: -.04em; }
  .summary-item span { font-size: 12px; color: var(--cp-text-muted); }
  .demo-banner, .notice {
    border: 1px solid var(--cp-border); background: var(--cp-bg-elevated); color: var(--cp-text-muted);
    border-radius: .625rem; padding: 12px 16px; margin-bottom: 20px; font-size: 12px; line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .demo-banner { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-left: 3px solid var(--cp-warning); }
  .demo-banner strong, .notice strong { display: block; color: var(--cp-text); }
  .notice.error { border-left: 3px solid var(--cp-danger); }
  .notice.compact { margin: 12px 0 0; padding: 10px; }
  .work-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
  .roster { position: sticky; top: 20px; min-width: 0; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  .section-heading h2, .section-heading h3 { font-size: 13px; font-weight: 650; }
  .count { padding: 2px 7px; border-radius: 5px; background: var(--cp-surface-soft); color: var(--cp-text-muted); font-size: 11px; }
  .agent-list { display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 330px); overflow-y: auto; padding: 2px; }
  .agent {
    width: 100%; display: flex; flex-shrink: 0; gap: 10px; text-align: left; align-items: flex-start;
    padding: 12px 10px; border: 1px solid var(--cp-border); border-radius: .625rem;
    background: var(--cp-surface); color: var(--cp-text);
  }
  .agent:hover { border-color: var(--cp-border-strong); }
  .agent.selected { border-color: var(--cp-accent); background: var(--cp-accent-soft); }
  .avatar {
    flex: 0 0 32px; height: 32px; display: grid; place-items: center;
    border-radius: 9px; background: var(--cp-surface-soft); border: 1px solid var(--cp-border);
    font-size: 12px; font-weight: 700; color: var(--cp-text);
  }
  .agent.selected .avatar { background: var(--cp-accent); border-color: var(--cp-accent); color: var(--cp-accent-fg); }
  .agent-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .agent-name { font-weight: 650; font-size: 13px; overflow-wrap: anywhere; }
  .agent-role { color: var(--cp-text-muted); font-size: 11px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .presence { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; color: var(--cp-text-muted); }
  .dot { display: inline-block; width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--cp-border-strong); }
  .dot.active { background: var(--cp-success); }
  .dot.idle { background: var(--cp-warning); }
  .dot.offline { background: var(--cp-danger); }
  .boundary-label { font-size: 10px; color: var(--cp-text-soft); line-height: 1.4; }
  rapp-verification { max-width: 100%; }
  .workspace-boundary rapp-verification, .approval rapp-verification, .vm-info rapp-verification { margin-top: 10px; }
  .roster-footer { margin-top: 20px; padding: 16px 0; border-top: 1px solid var(--cp-border); }
  .roster-footer p { font-size: 11px; color: var(--cp-text-muted); line-height: 1.6; margin: 12px 0; }
  .center, .inspector { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .panel { min-width: 0; border: 1px solid var(--cp-border); background: var(--cp-surface); border-radius: 16px; overflow: hidden; }
  .panel-padding { padding: 20px; }
  .panel-header { padding: 16px 20px; border-bottom: 1px solid var(--cp-border); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .panel-header h2, .panel-header h3 { font-size: 13px; font-weight: 650; }
  .thread-list { display: flex; flex-direction: column; gap: 6px; }
  .thread-button {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
    border: 1px solid var(--cp-border); background: var(--cp-surface); color: var(--cp-text);
    padding: 12px 14px; border-radius: .625rem; text-align: left; min-width: 0;
  }
  .thread-button[aria-pressed="true"] { background: var(--cp-bg-elevated); border-color: var(--cp-border-strong); }
  .thread-title { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .thread-meta { color: var(--cp-text-muted); font-size: 10px; white-space: nowrap; }
  .thread-heading { padding: 24px 24px 20px; border-bottom: 1px solid var(--cp-border); }
  .thread-heading h2 { margin: 10px 0 12px; font-size: 23px; line-height: 1.25; letter-spacing: -.025em; overflow-wrap: anywhere; }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; font-size: 10px; line-height: 1.4; color: var(--cp-text-muted); background: var(--cp-surface-soft); border: 1px solid var(--cp-border); }
  .pill.accent { background: var(--cp-accent-soft); color: var(--cp-accent); }
  .messages { padding: 24px; display: flex; flex-direction: column; gap: 24px; }
  .message { display: flex; align-items: flex-start; gap: 12px; }
  .message-body { min-width: 0; flex: 1; }
  .message-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 2px 0 8px; }
  .message-byline strong { font-size: 12px; }
  .message-byline time { font-size: 10px; color: var(--cp-text-muted); }
  .message p { font-size: 13px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
  .message.user p { color: var(--cp-text-muted); }
  .citation-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .citation-chip { border: 1px solid var(--cp-border); border-radius: 6px; background: var(--cp-bg-elevated); padding: 4px 7px; font-size: 10px; color: var(--cp-text-muted); }
  .thread-action { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-top: 1px solid var(--cp-border); background: var(--cp-bg-elevated); }
  .thread-action p { font-size: 11px; color: var(--cp-text-muted); line-height: 1.5; }
  .workspace-boundary { padding: 16px 20px; background: var(--cp-bg-elevated); border-bottom: 1px solid var(--cp-border); }
  .workspace-boundary strong { font-size: 11px; }
  .workspace-boundary dl { margin: 10px 0 0; display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 6px 8px; font-size: 10px; color: var(--cp-text-muted); }
  .workspace-boundary dd { margin: 0; overflow-wrap: anywhere; }
  code, pre { font-family: Consolas, "Courier New", Courier, monospace; }
  .timeline { list-style: none; padding: 0; margin: 0; }
  .timeline li { position: relative; padding: 0 0 20px 24px; font-size: 12px; }
  .timeline li:last-child { padding-bottom: 0; }
  .timeline li::before { content: ''; position: absolute; width: 7px; height: 7px; left: 0; top: 5px; border-radius: 50%; background: var(--cp-border-strong); }
  .timeline li:not(:last-child)::after { content: ''; position: absolute; width: 1px; left: 3px; top: 16px; bottom: 5px; background: var(--cp-border); }
  .timeline li.error::before { background: var(--cp-danger); }
  .timeline li.running::before { background: var(--cp-success); }
  .timeline-row { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
  .timeline time, .timeline p { color: var(--cp-text-muted); font-size: 10px; line-height: 1.6; margin-top: 4px; overflow-wrap: anywhere; }
  .timeline-row strong { font-weight: 600; }
  .computer-title { display: flex; align-items: center; gap: 8px; }
  .monitor-icon { width: 17px; height: 12px; display: inline-block; border: 1.5px solid var(--cp-text-muted); border-radius: 3px; position: relative; }
  .monitor-icon::after { content: ''; position: absolute; width: 7px; height: 1px; background: var(--cp-text-muted); bottom: -5px; left: 4px; }
  .vm-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: var(--cp-surface-soft); font-size: 10px; color: var(--cp-text-muted); }
  .vm-preview { position: relative; min-height: 200px; background: var(--cp-bg-elevated); padding: 22px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; }
  .vm-preview strong { font-size: 14px; letter-spacing: -.02em; }
  .vm-preview p { color: var(--cp-text-muted); font-size: 11px; line-height: 1.65; max-width: 240px; }
  .vm-placeholder { width: 50px; height: 38px; border: 1px solid var(--cp-border-strong); border-radius: 6px; margin-bottom: 8px; display: grid; place-items: center; color: var(--cp-text-muted); font: 18px Consolas, monospace; }
  .vm-frame { width: 100%; height: 240px; border: 0; display: block; background: var(--cp-bg-elevated); }
  .vm-info { padding: 16px; }
  .vm-info p { color: var(--cp-text-muted); font-size: 11px; line-height: 1.65; }
  .vm-info strong { color: var(--cp-text); }
  .vm-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .vm-check { margin-top: 10px; font-size: 10px; color: var(--cp-text-muted); }
  .approval { padding: 16px; border-bottom: 1px solid var(--cp-border); }
  .approval:last-child { border-bottom: 0; }
  .approval h3 { font-size: 12px; margin: 10px 0 8px; }
  .approval p { color: var(--cp-text-muted); font-size: 11px; line-height: 1.7; margin-bottom: 10px; }
  .approval code { display: block; background: var(--cp-bg-elevated); border: 1px solid var(--cp-border); border-radius: 6px; padding: 10px; font-size: 10px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
  .approval-actions { display: flex; gap: 8px; margin-top: 12px; }
  .evidence-item { padding: 16px; border-bottom: 1px solid var(--cp-border); }
  .evidence-item:last-child { border-bottom: 0; }
  .evidence-item summary { cursor: pointer; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
  .evidence-item p, .evidence-item code { display: block; font-size: 10px; line-height: 1.7; color: var(--cp-text-muted); margin-top: 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
  .evidence-item a { display: inline-block; color: var(--cp-link); margin-top: 8px; font-size: 11px; }
  .empty { padding: 24px 20px; color: var(--cp-text-muted); font-size: 12px; line-height: 1.75; }
  .empty strong { display: block; margin-bottom: 6px; color: var(--cp-text); }
  .footer-note { color: var(--cp-text-muted); font-size: 10px; line-height: 1.7; margin-top: 24px; text-align: center; }
  @media (max-width: 1380px) {
    .work { padding: 24px; }
    .work-grid { grid-template-columns: 180px minmax(0, 1fr) 280px; gap: 16px; }
    .thread-heading, .messages { padding: 20px; }
  }
  @media (max-width: 1180px) {
    .work-grid { grid-template-columns: 180px minmax(0, 1fr); }
    .inspector { grid-column: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
    .computer { grid-column: 1 / -1; }
    .vm-frame { height: 320px; }
    .vm-preview { min-height: 180px; }
  }
  @media (max-width: 680px) {
    .work { padding: 20px 16px; }
    .hero { align-items: flex-start; flex-direction: column; gap: 12px; }
    .hero h1 { font-size: 28px; }
    .summary { gap: 16px; flex-wrap: wrap; }
    .summary-item { gap: 6px; }
    .summary-item strong { font-size: 20px; }
    .summary-item span { font-size: 11px; }
    .demo-banner { flex-direction: column; align-items: flex-start; gap: 8px; }
    .work-grid { display: flex; flex-direction: column; }
    .roster, .center, .inspector { width: 100%; }
    .roster { position: static; }
    .agent-list { flex-direction: row; overflow-x: auto; overflow-y: hidden; max-height: none; padding: 2px 0 8px; }
    .agent { flex: 0 0 180px; }
    .roster-footer { display: none; }
    .thread-heading h2 { font-size: 22px; }
    .thread-action { flex-direction: column; align-items: flex-start; padding: 16px 20px; }
    .inspector { display: flex; align-items: stretch; }
    .thread-button { flex-wrap: wrap; }
    .vm-frame { height: 260px; }
  }
`;

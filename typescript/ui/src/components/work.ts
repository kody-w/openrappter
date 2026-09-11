import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import {
  workService, offline, localViewerUrl, evidenceUrl,
  type Capability, type WorkAgent, type WorkApproval, type WorkEvidence,
  type WorkMessage, type WorkThread, type WorkWorkspace, type VmStatus,
} from '../services/work.js';
import { LOCAL_WORK_DEMO } from '../services/work-demo.js';
import { workStyles } from './work-styles.js';
import { isWorkVerified, type WorkVerification } from '../services/work-rapp.js';
import './rapp-verification.js';

@customElement('rapp-work')
export class RappWork extends LitElement {
  static styles = workStyles;

  @property({ type: Boolean }) connected = false;
  @state() private agents: Capability<WorkAgent[]> = offline();
  @state() private workspaces: Capability<WorkWorkspace[]> = offline();
  @state() private threads: Capability<WorkThread[]> = offline();
  @state() private messages: Capability<WorkMessage[]> = offline();
  @state() private approvals: Capability<WorkApproval[]> = offline();
  @state() private workspaceDetail: Capability<WorkWorkspace> = offline();
  @state() private vm: Capability<VmStatus> = offline();
  @state() private selectedAgentId = '';
  @state() private selectedThreadId = '';
  @state() private demo = false;
  @state() private refreshing = false;
  @state() private busyApproval = '';
  @state() private approvalFeedback = '';
  @state() private approvalVerification?: WorkVerification;
  @state() private vmBusy = false;
  @state() private vmFeedback = '';
  @state() private vmActionVerification?: WorkVerification;
  @state() private lastVmCheck = '';
  @state() private observedRuns = new Set<string>();

  private demoDismissed = false;
  private generation = 0;
  private selectionGeneration = 0;
  private vmGeneration = 0;
  private refreshGeneration = 0;
  private poll?: ReturnType<typeof setInterval>;
  private vmPoll?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    gateway.on('chat', this.onChat);
    gateway.on('agent', this.onAgent);
    gateway.on('approval', this.onRefresh);
    gateway.on('workspace', this.onRefresh);
    gateway.on('presence', this.onRefresh);
    gateway.on('vm', this.onVm);
    if (this.hasUpdated) this.requestUpdate('connected', !this.connected);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.invalidate();
    workService.resetRappVerification();
    gateway.off('chat', this.onChat);
    gateway.off('agent', this.onAgent);
    gateway.off('approval', this.onRefresh);
    gateway.off('workspace', this.onRefresh);
    gateway.off('presence', this.onRefresh);
    gateway.off('vm', this.onVm);
  }

  protected willUpdate(changes: PropertyValues) {
    if (!changes.has('connected')) return;
    this.invalidate();
    workService.resetRappVerification();
    if (this.connected) {
      void this.refresh();
      void this.refreshVm();
      this.poll = setInterval(() => {
        if (document.visibilityState !== 'hidden') void this.refresh();
      }, 15_000);
      this.vmPoll = setInterval(() => {
        if (document.visibilityState !== 'hidden' && this.vm.state !== 'unavailable') {
          void this.refreshVm();
        }
      }, 5_000);
    } else {
      this.agents = offline();
      this.workspaces = offline();
      this.threads = offline();
      this.messages = offline();
      this.approvals = offline();
      this.workspaceDetail = offline();
      this.vm = offline();
      this.demo = false;
      this.lastVmCheck = '';
      this.approvalFeedback = '';
      this.vmFeedback = '';
      this.approvalVerification = undefined;
      this.vmActionVerification = undefined;
      this.observedRuns = new Set();
    }
  }

  private invalidate() {
    this.generation++;
    this.selectionGeneration++;
    this.vmGeneration++;
    this.refreshGeneration++;
    clearInterval(this.poll);
    clearInterval(this.vmPoll);
    this.refreshing = false;
    this.busyApproval = '';
    this.vmBusy = false;
  }

  private onRefresh = () => { void this.refresh(); };
  private onVm = () => { void this.refreshVm(); };
  private onAgent = () => { void this.refresh(); };

  private onChat = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const event = value as { sessionId?: string; sessionKey?: string; state?: string };
    const sessionId = event.sessionId ?? event.sessionKey;
    if (!sessionId) return;
    const runs = new Set(this.observedRuns);
    if (event.state === 'delta') runs.add(sessionId);
    else if (['final', 'error', 'aborted'].includes(event.state ?? '')) runs.delete(sessionId);
    this.observedRuns = runs;
    if (['final', 'error', 'aborted'].includes(event.state ?? '')) {
      void this.refresh();
    }
  };

  private async refresh() {
    if (!this.connected || this.refreshing || this.busyApproval) return;
    this.refreshing = true;
    const generation = this.generation;
    const refreshGeneration = ++this.refreshGeneration;
    const [agents, workspaces, threads, approvals] = await Promise.all([
      workService.listAgents(), workService.listWorkspaces(),
      workService.listThreads(), workService.pendingApprovals(),
    ]);
    if (!this.isConnected || !this.connected || generation !== this.generation
      || refreshGeneration !== this.refreshGeneration) return;
    this.agents = agents;
    this.workspaces = workspaces;
    this.threads = threads;
    this.approvals = approvals;
    this.demo = this.canPreviewDemo && !this.demoDismissed;
    const previousSelection = `${this.selectedAgentId}/${this.selectedThreadId}`;
    this.ensureSelection();
    this.refreshing = false;
    if (!this.demo) void this.loadSelection(previousSelection === `${this.selectedAgentId}/${this.selectedThreadId}`);
  }

  private async refreshVm() {
    if (!this.connected || this.vmBusy) return;
    const generation = ++this.vmGeneration;
    const result = await workService.vmStatus();
    if (!this.isConnected || !this.connected || generation !== this.vmGeneration) return;
    this.vm = result;
    this.lastVmCheck = result.state === 'live' ? this.clock(new Date().toISOString()) : '';
  }

  private get visibleAgents(): WorkAgent[] {
    if (this.demo) return LOCAL_WORK_DEMO.agents;
    const agents = new Map((this.agents.state === 'live' ? this.agents.data : []).map((agent) => [agent.id, agent]));
    for (const workspace of this.workspaces.state === 'live' ? this.workspaces.data : []) {
      if (!agents.has(workspace.agentId)) agents.set(workspace.agentId, {
        id: workspace.agentId, name: workspace.agentId, description: 'Workspace owner', presence: workspace.status,
      });
    }
    for (const thread of this.threads.state === 'live' ? this.threads.data : []) {
      if (!agents.has(thread.agentId)) agents.set(thread.agentId, {
        id: thread.agentId, name: thread.agentId === 'default' ? 'Assistant' : thread.agentId,
        description: 'Session owner reported by gateway', presence: 'unknown',
      });
    }
    return [...agents.values()];
  }

  private get canPreviewDemo() {
    return this.workspaces.state === 'unavailable'
      && [this.agents, this.threads, this.approvals].every((result) => result.state !== 'error');
  }

  private get visibleWorkspaces() {
    return this.demo ? LOCAL_WORK_DEMO.workspaces : this.workspaces.state === 'live' ? this.workspaces.data : [];
  }

  private get visibleThreads() {
    return this.demo ? LOCAL_WORK_DEMO.threads : this.threads.state === 'live' ? this.threads.data : [];
  }

  private get agentThreads() {
    return this.visibleThreads.filter((thread) => thread.agentId === this.selectedAgentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private get visibleMessages() {
    return this.demo ? LOCAL_WORK_DEMO.messages[this.selectedThreadId] ?? []
      : this.messages.state === 'live' ? this.messages.data : [];
  }

  private get visibleApprovals() {
    return this.demo ? LOCAL_WORK_DEMO.approvals
      : this.approvals.state === 'live' ? this.approvals.data : [];
  }

  private get selectedAgent() {
    return this.visibleAgents.find((agent) => agent.id === this.selectedAgentId);
  }

  private get selectedThread() {
    return this.agentThreads.find((thread) => thread.id === this.selectedThreadId);
  }

  private get selectedWorkspace() {
    if (!this.demo && this.workspaces.state === 'live' && this.workspaceDetail.state === 'live'
      && this.workspaceDetail.data.agentId === this.selectedAgentId) {
      return this.workspaceDetail.data;
    }
    return this.visibleWorkspaces.find((workspace) => workspace.agentId === this.selectedAgentId);
  }

  private ensureSelection() {
    if (!this.visibleAgents.some((agent) => agent.id === this.selectedAgentId)) {
      this.selectedAgentId = this.visibleAgents.find((agent) =>
        this.visibleThreads.some((thread) => thread.agentId === agent.id))?.id
        ?? this.visibleAgents[0]?.id ?? '';
    }
    if (!this.agentThreads.some((thread) => thread.id === this.selectedThreadId)) {
      this.selectedThreadId = this.agentThreads[0]?.id ?? '';
    }
  }

  private selectAgent(agentId: string) {
    if (agentId === this.selectedAgentId) return;
    this.selectedAgentId = agentId;
    this.ensureSelection();
    void this.loadSelection();
  }

  private selectThread(threadId: string) {
    if (!this.agentThreads.some((thread) => thread.id === threadId)) return;
    this.selectedThreadId = threadId;
    void this.loadSelection();
  }

  private async loadSelection(preserve = false) {
    const generation = ++this.selectionGeneration;
    if (!preserve) {
      this.messages = { state: 'loading', detail: 'Loading thread…' };
      this.workspaceDetail = offline();
    }
    if (this.demo || !this.connected) return;
    const agentId = this.selectedAgentId;
    const workspace = this.visibleWorkspaces.find((item) => item.agentId === agentId);
    const thread = this.selectedThread;
    const [messages, detail] = await Promise.all([
      thread ? workService.messages(thread.id) : Promise.resolve({ state: 'live' as const, data: [] }),
      workspace ? workService.getWorkspace(workspace.id) : Promise.resolve(offline<WorkWorkspace>()),
    ]);
    if (!this.isConnected || !this.connected || generation !== this.selectionGeneration) return;
    this.messages = messages;
    this.workspaceDetail = detail.state === 'live' && detail.data.agentId !== agentId
      ? { state: 'error', method: 'workspace.get', detail: 'Workspace owner did not match the selected agent.' }
      : detail;
  }

  private toggleDemo() {
    if (!this.canPreviewDemo) return;
    this.demo = !this.demo;
    this.demoDismissed = !this.demo;
    this.ensureSelection();
    void this.loadSelection();
  }

  private navigate(view: string, sessionId?: string) {
    this.dispatchEvent(new CustomEvent('navigate', {
      detail: { view, ...(sessionId ? { sessionId } : {}) }, bubbles: true, composed: true,
    }));
  }

  private agentPresence(agent: WorkAgent) {
    if (!this.demo && this.visibleThreads.some((thread) =>
      thread.agentId === agent.id && this.observedRuns.has(thread.id))) return 'active';
    const status = this.visibleWorkspaces.find((workspace) => workspace.agentId === agent.id)?.status;
    return status && status !== 'unknown' ? status : agent.presence;
  }

  private boundary(workspace: WorkWorkspace | undefined): string {
    if (!workspace) return 'Workspace not reported';
    const conflict = this.visibleWorkspaces.some((other) => other.agentId !== workspace.agentId
      && ((workspace.rootPath && other.rootPath === workspace.rootPath)
        || (workspace.memoryPath && other.memoryPath === workspace.memoryPath)));
    if (conflict) return 'Shared path detected';
    if (workspace.isolation === 'dedicated') return 'Independent workspace';
    if (workspace.isolation === 'shared') return 'Shared workspace';
    return 'Isolation not reported';
  }

  private clock(timestamp: string) {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time not reported';
  }

  private capabilityNotice<T>(result: Capability<T>, label: string) {
    if (result.state === 'live') return nothing;
    return html`<div class="notice compact ${result.state === 'error' ? 'error' : ''}"
      role=${result.state === 'error' ? 'alert' : 'status'}>
      <strong>${label} ${result.state === 'unavailable' ? 'unavailable' : result.state === 'error' ? 'could not load' : ''}</strong>
      ${'method' in result ? html`<code>${result.method}</code> · ` : nothing}${result.detail}
    </div>`;
  }

  private async decideApproval(approval: WorkApproval, approved: boolean) {
    if (this.demo || !this.connected || this.busyApproval || !isWorkVerified(approval.rapp)
      || (approval.expiresAt && approval.expiresAt <= Date.now())) return;
    this.busyApproval = approval.id;
    this.refreshGeneration++;
    this.refreshing = false;
    this.approvalFeedback = '';
    this.approvalVerification = undefined;
    const generation = this.generation;
    const result = await workService.respondToApproval(approval.id, approved);
    if (!this.isConnected || !this.connected || generation !== this.generation) return;
    this.busyApproval = '';
    if (result.state === 'live') {
      this.approvalVerification = result.data.rapp;
      this.approvalFeedback = `Gateway confirmed: ${result.data.status}. RAPP/1 integrity verified.`;
      if (this.approvals.state === 'live') {
        this.approvals = { state: 'live', data: this.approvals.data.filter((item) => item.id !== approval.id) };
      }
      void this.refresh();
    } else {
      this.approvalVerification = 'rapp' in result ? result.rapp : undefined;
      this.approvalFeedback = `${result.state === 'unavailable' ? 'Approval method unavailable.' : 'Decision not confirmed.'} ${result.detail}`;
    }
  }

  private async changeVm(action: 'start' | 'stop') {
    if (!this.connected || this.vmBusy || this.vm.state !== 'live' || !this.vm.data.local || !isWorkVerified(this.vm.data.rapp)) return;
    if (this.vm.data.state !== (action === 'start' ? 'stopped' : 'running')) return;
    this.vmBusy = true;
    this.vmFeedback = '';
    this.vmActionVerification = undefined;
    const generation = ++this.vmGeneration;
    const result = await (action === 'start' ? workService.startVm() : workService.stopVm());
    if (!this.isConnected || !this.connected || generation !== this.vmGeneration) return;
    this.vmBusy = false;
    if (result.state === 'live') {
      this.vm = result;
      this.lastVmCheck = this.clock(new Date().toISOString());
    } else {
      this.vmActionVerification = 'rapp' in result ? result.rapp : undefined;
      this.vmFeedback = `${action === 'start' ? 'Start' : 'Stop'} not confirmed. ${result.detail}`;
    }
  }

  private get evidence(): WorkEvidence[] {
    return this.visibleMessages.flatMap((message) => [
      ...(message.citations ?? []),
      ...(message.toolCalls ?? []).filter((tool) => tool.result !== undefined).map((tool) => ({
        id: tool.id, title: `${tool.name} · ${tool.status}`, source: `Tool receipt · ${tool.id}`,
        excerpt: (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result)).slice(0, 2000),
        rapp: tool.rapp,
      })),
    ]);
  }

  private renderRoster() {
    return html`<aside class="roster" aria-label="Persistent agent roster">
      <div class="section-heading"><h2>Your workforce</h2><span class="count">${this.visibleAgents.length}</span></div>
      <div class="agent-list">
        ${this.visibleAgents.map((agent) => {
          const status = this.agentPresence(agent);
          return html`<button class="agent ${agent.id === this.selectedAgentId ? 'selected' : ''}"
            aria-pressed=${agent.id === this.selectedAgentId} @click=${() => this.selectAgent(agent.id)}
            data-agent-id=${agent.id}>
            <span class="avatar" aria-hidden="true">${agent.name.slice(0, 2).toUpperCase()}</span>
            <span class="agent-copy">
              <span class="agent-name">${agent.name}</span>
              <span class="agent-role">${agent.description}</span>
              <span class="presence"><span class="dot ${status}"></span>
                ${status === 'unknown' ? 'Presence unknown' : status[0].toUpperCase() + status.slice(1)}
                ${this.demo ? ' · Example' : ''}
              </span>
              <span class="boundary-label">${this.boundary(this.visibleWorkspaces.find((item) => item.agentId === agent.id))}</span>
              <rapp-verification .verification=${agent.rapp} .demo=${this.demo} compact></rapp-verification>
            </span>
          </button>`;
        })}
      </div>
      ${!this.demo ? this.capabilityNotice(this.agents, 'Agent roster') : nothing}
      ${!this.visibleAgents.length ? html`<p class="empty">No agents reported yet.</p>` : nothing}
      <div class="roster-footer">
        <button class="text-button" @click=${() => this.navigate('agents')}>Manage agents →</button>
        <p>Separate workspaces, shared visibility. Boundaries are reported, not enforced here. Presence is a live hint, not durable history.</p>
        <span class="eyebrow">${this.demo ? 'Example workforce' : 'Gateway-reported activity'}</span>
      </div>
    </aside>`;
  }

  private renderThread() {
    const thread = this.selectedThread;
    const workspace = this.selectedWorkspace;
    const messages = this.visibleMessages;
    const evidence = this.evidence;
    return html`<section class="center" aria-label="Work threads and run timeline">
      <div>
        <div class="section-heading"><h2>Work threads</h2><span class="count">${this.agentThreads.length}</span></div>
        <div class="thread-list">
          ${this.agentThreads.map((item) => html`<button class="thread-button"
            aria-pressed=${item.id === this.selectedThreadId} @click=${() => this.selectThread(item.id)}>
            <span class="thread-title">${item.title ?? item.id}</span>
            <span class="thread-meta">${item.messageCount} messages${this.demo ? ' · Example' : ''}</span>
            <rapp-verification .verification=${item.rapp} .demo=${this.demo} compact></rapp-verification>
          </button>`)}
        </div>
        ${!this.demo ? this.capabilityNotice(this.threads, 'Threads') : nothing}
      </div>
      <article class="panel" aria-label="Selected work thread">
        <div class="thread-heading">
          <span class="eyebrow">${this.demo ? 'Example work thread' : thread ? 'Gateway work thread' : 'Work thread'}</span>
          <h2>${thread?.title ?? (thread ? thread.id : 'Make room for meaningful work.')}</h2>
          <div class="pills">
            <span class="pill">${this.selectedAgent?.name ?? 'No agent selected'}</span>
            <span class="pill">${this.boundary(workspace)}</span>
            ${this.demo ? html`<span class="pill accent">Read-only example</span>` : nothing}
            ${thread && this.observedRuns.has(thread.id) && !this.demo
              ? html`<span class="pill"><span class="dot active"></span>Active run observed</span>` : nothing}
          </div>
        </div>
        <div class="workspace-boundary" aria-label="Agent workspace isolation">
          <strong>${this.demo ? 'Example paths · not created' : workspace ? 'Workspace boundary · gateway reported' : 'Workspace boundary not reported'}</strong>
          <dl>
            <dt>Files</dt><dd><code>${workspace?.rootPath ?? 'Not reported'}</code></dd>
            <dt>Memory</dt><dd><code>${workspace?.memoryPath ?? 'Not reported'}</code></dd>
          </dl>
          <rapp-verification .verification=${workspace?.rapp} .demo=${this.demo}></rapp-verification>
          ${!this.demo && (this.workspaceDetail.state === 'error' || this.workspaceDetail.state === 'unavailable')
            ? this.capabilityNotice(this.workspaceDetail, 'Workspace details') : nothing}
        </div>
        ${messages.length ? html`<div class="messages">
          ${messages.map((message) => html`<div class="message ${message.role}">
            <span class="avatar" aria-hidden="true">${message.role === 'user' ? 'Y' : this.selectedAgent?.name.slice(0, 2).toUpperCase() ?? 'AI'}</span>
            <div class="message-body">
              <div class="message-byline">
                <strong>${message.role === 'user' ? 'You' : message.role === 'assistant' ? this.selectedAgent?.name ?? 'Assistant' : message.role}</strong>
                <time datetime=${message.timestamp}>${this.clock(message.timestamp)}${this.demo ? ' · Example' : ''}</time>
                <rapp-verification .verification=${message.rapp} .demo=${this.demo} compact></rapp-verification>
              </div>
              <p>${message.content}</p>
              ${message.citations?.length ? html`<div class="citation-chips">
                ${message.citations.map((citation) => html`<span class="citation-chip">[${evidence.indexOf(citation) + 1}] ${citation.title}</span>`)}
              </div>` : nothing}
            </div>
          </div>`)}
        </div>` : html`<div class="empty">
          <strong>${thread ? 'No recorded messages to display.' : 'No threads for this agent yet.'}</strong>
          Start work in Chat using the existing gateway assistant. This view does not claim isolated agent execution.
          ${!this.demo && thread ? this.capabilityNotice(this.messages, 'Messages') : nothing}
        </div>`}
        <div class="thread-action">
          <p>${this.demo ? 'Example only. No files have been read or written.' : 'Compatibility Chat is unverified. Its output is not canonical Work history without a frame-backed gateway adapter.'}</p>
          <button class="button small" ?disabled=${this.demo || !this.connected}
            @click=${() => this.navigate('chat', thread?.id)}>${thread ? 'Open compatibility Chat →' : 'Compatibility Chat →'}</button>
        </div>
      </article>
      <section class="panel" aria-label="Task and run timeline">
        <div class="panel-header"><h3>Task / run timeline</h3><span class="pill">${this.demo ? 'Example run' : 'Recorded events'}</span></div>
        <div class="panel-padding">
          ${messages.length ? html`<ol class="timeline">
            ${messages.map((message) => html`
              <li><div class="timeline-row"><strong>${message.role === 'user' ? 'Brief received' : message.role === 'tool' ? 'Tool result recorded' : 'Response recorded'}</strong>
                <time datetime=${message.timestamp}>${this.clock(message.timestamp)}</time></div>
                <p>${this.demo ? 'Illustrative event, not an executed step' : isWorkVerified(message.rapp)
                  ? `Memory frame · ${message.rapp.scan.source_frame_hash}` : `Unverified message projection · ${message.id}`}</p>
                <rapp-verification .verification=${message.rapp} .demo=${this.demo} compact></rapp-verification>
              </li>
              ${(message.toolCalls ?? []).map((tool) => html`<li class=${tool.status}>
                <div class="timeline-row"><strong>${tool.name}</strong><span class="pill">${tool.status}</span></div>
                <p>Tool receipt · ${tool.id}${tool.error ? ` · ${tool.error}` : ''}</p>
                <rapp-verification .verification=${tool.rapp} .demo=${this.demo} compact></rapp-verification>
              </li>`)}
            `)}
          </ol>` : html`<p class="muted">No run receipts yet. Activity appears here when the gateway records messages or tool results.</p>`}
        </div>
      </section>
    </section>`;
  }

  private renderComputer() {
    const vm = this.vm.state === 'live' ? this.vm.data : null;
    const viewer = vm?.local && vm.state === 'running' ? localViewerUrl(vm.viewerUrl) : null;
    return html`<section class="panel computer" aria-label="Shared local computer">
      <div class="panel-header">
        <h2 class="computer-title"><span class="monitor-icon" aria-hidden="true"></span>Local computer</h2>
        <span class="pill">${vm ? 'Gateway status' : 'Not connected'}</span>
      </div>
      <div class="vm-toolbar"><span>OMARCHY VM</span><span>${vm?.state ?? 'Display unavailable'} · Shared screen</span></div>
      ${viewer ? html`<iframe class="vm-frame" title="Live local Omarchy desktop"
        src=${viewer} sandbox="allow-scripts allow-forms allow-pointer-lock" referrerpolicy="no-referrer"
        data-desktop-private tabindex="-1" inert></iframe>` : html`<div class="vm-preview">
        <div class="vm-placeholder" aria-hidden="true">›_</div>
        <strong>${this.vm.state === 'unavailable' ? 'Local display not available yet' : vm?.state === 'stopped' ? 'Your local computer is stopped' : 'Waiting for a local display'}</strong>
        <p>${this.vm.state === 'unavailable'
          ? 'vm.status is unavailable on this gateway. This is a placeholder, not a live VM or a hosted browser.'
          : vm && !vm.local ? 'The gateway has not confirmed a local VM. Remote displays are not embedded.'
          : vm?.state === 'running' ? 'The VM reports running, but no safe loopback viewer URL was provided.'
          : 'A live Omarchy view appears here when your gateway reports a local VM and display.'}</p>
      </div>`}
      <div class="vm-info">
        <rapp-verification .verification=${vm?.rapp}></rapp-verification>
        <p><strong>${vm?.local ? 'On your machine. Not in a hosted browser.' : 'A local VM, not a hosted browser.'}</strong><br>
          Omarchy runs on the local gateway machine. Agents share this computer’s screen; their workspace boundaries are shown separately.</p>
        ${vm?.message ? html`<div class="notice compact">${vm.message}</div>` : nothing}
        ${vm?.activeAgentId ? html`<p>Computer operator: ${vm.activeAgentId}</p>` : nothing}
        ${this.vm.state !== 'live' && this.vm.state !== 'unavailable'
          ? this.capabilityNotice(this.vm, 'VM status') : nothing}
        <div class="vm-actions">
          <button class="button small" data-desktop-sensitive="vm-control"
            ?disabled=${!this.connected || this.vmBusy || !vm?.local || vm.state !== 'stopped' || !isWorkVerified(vm.rapp)}
            @click=${() => this.changeVm('start')}>Start VM</button>
          <button class="button small" data-desktop-sensitive="vm-control"
            ?disabled=${!this.connected || this.vmBusy || !vm?.local || vm.state !== 'running' || !isWorkVerified(vm.rapp)}
            @click=${() => this.changeVm('stop')}>Stop VM</button>
          <button class="button small" ?disabled=${!this.connected || this.vmBusy}
            @click=${() => this.refreshVm()}>Refresh status</button>
        </div>
        ${vm && !isWorkVerified(vm.rapp) ? html`<p>VM mutations are blocked until canonical frame evidence is verified. The display is view-only.</p>` : nothing}
        <div class="vm-check" role="status">${this.vmBusy ? 'Waiting for gateway confirmation…' : this.lastVmCheck ? `Status checked ${this.lastVmCheck} · refreshes every 5s` : 'No VM operation has been confirmed.'}</div>
        ${this.vmFeedback ? html`<div class="notice compact error" role="alert">${this.vmFeedback}
          <rapp-verification .verification=${this.vmActionVerification}></rapp-verification></div>` : nothing}
      </div>
    </section>`;
  }

  private renderApprovals() {
    return html`<section class="panel" aria-label="Approvals">
      <div class="panel-header"><h2>Needs your approval</h2><span class="count">${this.visibleApprovals.length}</span></div>
      ${this.visibleApprovals.map((approval) => {
        const expired = !!approval.expiresAt && approval.expiresAt <= Date.now();
        return html`<article class="approval">
          <span class="pill accent">${this.demo ? 'Example · not actionable' : 'Gateway-wide execution approval'}</span>
          <h3>${approval.agentId ? `${this.visibleAgents.find((agent) => agent.id === approval.agentId)?.name ?? approval.agentId} requests review` : 'Agent not supplied by gateway'}</h3>
          <p>${approval.description}</p><code>${approval.command}</code>
          <rapp-verification .verification=${approval.rapp} .demo=${this.demo}></rapp-verification>
          <div class="approval-actions">
            <button class="button primary small" data-desktop-sensitive="execution-approval"
              ?disabled=${this.demo || !this.connected || !!this.busyApproval || expired || !isWorkVerified(approval.rapp)}
              @click=${() => this.decideApproval(approval, true)}>Approve${this.demo ? ' (demo)' : ''}</button>
            <button class="button small" data-desktop-sensitive="execution-approval"
              ?disabled=${this.demo || !this.connected || !!this.busyApproval || expired || !isWorkVerified(approval.rapp)}
              @click=${() => this.decideApproval(approval, false)}>Deny${this.demo ? ' (demo)' : ''}</button>
          </div>
          ${!this.demo && !isWorkVerified(approval.rapp) ? html`<p>Decision blocked: verified RAPP/1 request and committed-head evidence are required.</p>` : nothing}
          ${expired ? html`<p>Expired. Refresh to check the current queue.</p>` : nothing}
        </article>`;
      })}
      ${!this.demo && this.approvals.state !== 'live'
        ? html`<div class="panel-padding">${this.capabilityNotice(this.approvals, 'Approval queue')}</div>` : nothing}
      ${!this.visibleApprovals.length && this.approvals.state === 'live'
        ? html`<div class="empty"><strong>No pending approvals.</strong>The gateway’s execution requests will appear here. Approving is a deliberate action, never an automatic step.</div>` : nothing}
      ${this.approvalFeedback ? html`<div class="panel-padding"><p class="muted" role="status">${this.approvalFeedback}</p>
        <rapp-verification .verification=${this.approvalVerification}></rapp-verification></div>` : nothing}
    </section>`;
  }

  private renderEvidence() {
    return html`<section class="panel" aria-label="Evidence and citations">
      <div class="panel-header"><h2>Evidence & citations</h2><span class="count">${this.evidence.length}</span></div>
      ${this.evidence.map((item, index) => html`<details class="evidence-item">
        <summary>[${index + 1}] ${item.title}</summary>
        <p>${this.demo ? 'Example source · not verified' : 'Gateway-reported source · not independently verified'}</p>
        <code>${item.source}</code><p>${item.excerpt}</p>
        <rapp-verification .verification=${item.rapp} .demo=${this.demo}></rapp-verification>
        ${!this.demo && evidenceUrl(item.url)
          ? html`<a href=${evidenceUrl(item.url)!} target="_blank" rel="noopener noreferrer">Open cited source ↗</a>` : nothing}
      </details>`)}
      ${!this.evidence.length ? html`<div class="empty">No source receipts were supplied for this thread. An answer without evidence is not a verified result.</div>` : nothing}
    </section>`;
  }

  render() {
    const liveApprovalCount = this.approvals.state === 'live' ? this.approvals.data.length : 0;
    return html`<div class="work">
      <header class="hero">
        <div><span class="eyebrow">RAPP Work · Local-first</span><h1>Your local AI workforce.</h1>
          <p>Real business work. Visible progress. Decisions stay with you.</p></div>
        <button class="button primary" ?disabled=${!this.connected} @click=${() => this.navigate('chat')}
          title="Open unverified compatibility Chat; this does not submit a canonical Work action">Compatibility Chat ↗</button>
      </header>
      <div class="notice provenance-notice">
        <strong>RAPP/1 verification is per item, never assumed.</strong>
        Work is a derived view. Verified badges require scanned frames, checked hashes and lineage, selected authority, and committed heads.
        Unverified compatibility data and read-only examples are not compliant event history.
      </div>
      ${this.demo ? html`<div class="demo-banner" role="status" data-demo="true">
        <div><strong>Local demo · read-only</strong>
          <code>workspace.list</code> is unavailable on this gateway. The workforce, threads, approvals, and paths below are examples — no work is running.
        </div>
        <button class="button small" @click=${this.toggleDemo}>Use gateway data${liveApprovalCount ? ` · ${liveApprovalCount} live approvals` : ''}</button>
      </div>` : this.workspaces.state === 'unavailable'
        ? html`<div class="demo-banner"><div><strong>Workspace capability unavailable</strong>
          This gateway does not report workspace boundaries. Other capabilities are shown independently.</div>
          ${this.canPreviewDemo ? html`<button class="button small" @click=${this.toggleDemo}>Preview local demo</button>`
            : html`<span>Resolve the live data errors before opening a demo.</span>`}</div>`
        : this.workspaces.state !== 'live' ? this.capabilityNotice(this.workspaces, 'Workspaces') : nothing}
      <div class="summary" aria-label="Work summary">
        <div class="summary-item"><strong>${this.demo || this.agents.state === 'live' || this.visibleAgents.length ? this.visibleAgents.length : '—'}</strong><span>agents${this.demo ? ' · example' : ''}</span></div>
        <div class="summary-item"><strong>${this.demo || this.threads.state === 'live' ? this.visibleThreads.length : '—'}</strong><span>work threads</span></div>
        <div class="summary-item"><strong>${this.demo || this.approvals.state === 'live' ? this.visibleApprovals.length : '—'}</strong><span>to review</span></div>
        <button class="button small" ?disabled=${!this.connected || this.refreshing} @click=${() => this.refresh()}
          aria-label="Refresh work data">${this.refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div class="work-grid">${this.renderRoster()}${this.renderThread()}
        <aside class="inspector" aria-label="Computer, approvals, and evidence">
          ${this.renderComputer()}${this.renderApprovals()}${this.renderEvidence()}
        </aside>
      </div>
      <p class="footer-note">Local workspaces & a local computer. Model inference may use your configured cloud provider.
        ${this.demo ? 'All example work shown here is read-only and is not saved.'
          : this.connected ? 'Live data is reported by your gateway.' : 'Gateway offline. No live work data is available.'}</p>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rapp-work': RappWork;
  }
}

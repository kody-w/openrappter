/**
 * Accounts View Component
 * GitHub account sign-in, sign-out, and switching.
 * Switch accounts when you run out of Copilot capacity on one.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface ProfileInfo {
  id: string;
  provider: string;
  type: string;
  username?: string;
  default: boolean;
  createdAt: string;
}

interface LoginFlow {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
}

@customElement('openrappter-accounts')
export class OpenRappterAccounts extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
    }

    .page-header { margin-bottom: 1.25rem; }
    .page-header h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .page-header p { font-size: 0.875rem; color: var(--text-secondary); }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }

    .btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.8125rem;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn:hover { background: var(--border); }

    .btn-primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .btn-primary:hover { opacity: 0.9; background: var(--accent); }

    .btn-danger {
      border-color: var(--error);
      color: var(--error);
    }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.1); }

    .btn-sm {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
    }

    .count-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.625rem;
      border-radius: 1rem;
      background: var(--accent);
      color: white;
      font-weight: 600;
    }

    /* Account cards */
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: 640px;
    }

    .account-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      transition: border-color 0.15s ease;
    }

    .account-card.active {
      border-color: var(--accent);
    }

    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--bg-tertiary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
      flex-shrink: 0;
      overflow: hidden;
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .account-main { flex: 1; min-width: 0; }

    .account-name {
      font-weight: 600;
      font-size: 0.9375rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .active-badge {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
      font-weight: 600;
    }

    .account-sub {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-top: 0.125rem;
    }

    .account-actions {
      display: flex;
      gap: 0.375rem;
      flex-shrink: 0;
    }

    /* Device code login modal */
    .login-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .login-modal {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 2rem;
      max-width: 420px;
      width: 90%;
      text-align: center;
    }

    .login-modal h3 {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }

    .login-modal p {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
      line-height: 1.5;
    }

    .device-code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: var(--accent);
      padding: 0.75rem 1.5rem;
      background: var(--bg-secondary);
      border: 2px dashed var(--border);
      border-radius: 0.5rem;
      margin: 1rem 0;
      user-select: all;
    }

    .login-steps {
      text-align: left;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin: 1rem 0;
      line-height: 1.8;
    }

    .login-steps li {
      margin-bottom: 0.25rem;
    }

    .login-steps a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }
    .login-steps a:hover { text-decoration: underline; }

    .login-status {
      font-size: 0.8125rem;
      margin-top: 0.75rem;
    }

    .login-status.pending { color: var(--text-secondary); }
    .login-status.success { color: var(--accent); }
    .login-status.error { color: var(--error); }

    .spinner-inline {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 0.375rem;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .modal-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      margin-top: 1.25rem;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .empty-state p { margin-bottom: 1rem; }

    .tip {
      max-width: 640px;
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-top: 1.5rem;
      line-height: 1.6;
    }

    .tip strong { color: var(--text-primary); }
  `;

  @state() private profiles: ProfileInfo[] = [];
  @state() private loading = true;
  @state() private loginFlow: LoginFlow | null = null;
  @state() private loginStatus: 'idle' | 'pending' | 'success' | 'error' = 'idle';
  @state() private loginMessage = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.loadProfiles();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async loadProfiles() {
    this.loading = true;
    try {
      this.profiles = await gateway.call<ProfileInfo[]>('auth.profiles');
    } catch {
      this.profiles = [];
    }
    this.loading = false;
  }

  private async startLogin() {
    try {
      this.loginFlow = await gateway.call<LoginFlow>('auth.login');
      this.loginStatus = 'pending';
      this.loginMessage = 'Waiting for you to authorize…';

      // Start polling
      this.pollTimer = setInterval(() => this.checkLogin(), 3000);
    } catch (err) {
      this.loginStatus = 'error';
      this.loginMessage = `Failed to start login: ${(err as Error).message}`;
    }
  }

  private async checkLogin() {
    if (!this.loginFlow) return;

    try {
      const result = await gateway.call<{ status: string; username?: string; error?: string }>(
        'auth.poll',
        { deviceCode: this.loginFlow.deviceCode }
      );

      if (result.status === 'success') {
        this.loginStatus = 'success';
        this.loginMessage = `Signed in as ${result.username}!`;
        if (this.pollTimer) clearInterval(this.pollTimer);
        // Reload profiles after a short delay
        setTimeout(() => {
          this.loginFlow = null;
          this.loginStatus = 'idle';
          this.loadProfiles();
        }, 1500);
      } else if (result.status === 'error') {
        this.loginStatus = 'error';
        this.loginMessage = result.error ?? 'Login failed';
        if (this.pollTimer) clearInterval(this.pollTimer);
      }
      // 'pending' — keep polling
    } catch {
      // Network error, keep polling
    }
  }

  private cancelLogin() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.loginFlow = null;
    this.loginStatus = 'idle';
    this.loginMessage = '';
  }

  private async switchAccount(id: string) {
    try {
      await gateway.call('auth.switch', { id });
      await this.loadProfiles();
    } catch (err) {
      console.error('Failed to switch account:', err);
    }
  }

  private async removeAccount(id: string) {
    try {
      await gateway.call('auth.remove', { id });
      await this.loadProfiles();
    } catch (err) {
      console.error('Failed to remove account:', err);
    }
  }

  private formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  render() {
    return html`
      <div class="page-header">
        <h2>GitHub Accounts</h2>
        <p>Sign in with multiple GitHub accounts and switch when you hit capacity limits.</p>
      </div>

      <div class="toolbar">
        <span class="count-badge">${this.profiles.length} account${this.profiles.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-primary" @click=${() => this.startLogin()}>+ Add Account</button>
        <button class="btn" @click=${() => this.loadProfiles()}>Refresh</button>
      </div>

      ${this.loading
        ? html`<div class="empty-state">Loading accounts…</div>`
        : this.profiles.length === 0
          ? html`
              <div class="empty-state">
                <p>No GitHub accounts linked yet.</p>
                <button class="btn btn-primary" @click=${() => this.startLogin()}>Sign in with GitHub</button>
              </div>
            `
          : html`
              <div class="accounts-list">
                ${this.profiles.map((p) => this.renderAccount(p))}
              </div>
            `
      }

      <div class="tip">
        <strong>💡 Tip:</strong> Free GitHub Copilot accounts have usage limits that reset periodically.
        Add multiple accounts and switch between them when you hit a limit — your active account
        is used for all AI requests.
      </div>

      ${this.loginFlow ? this.renderLoginModal() : nothing}
    `;
  }

  private renderAccount(p: ProfileInfo) {
    const username = p.username ?? p.id;
    return html`
      <div class="account-card ${p.default ? 'active' : ''}">
        <div class="avatar">
          <img
            src="https://github.com/${username}.png?size=80"
            alt="${username}"
            @error=${(e: Event) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).parentElement!.textContent = '👤';
            }}
          />
        </div>
        <div class="account-main">
          <div class="account-name">
            ${username}
            ${p.default ? html`<span class="active-badge">✓ Active</span>` : nothing}
          </div>
          <div class="account-sub">Added ${this.formatDate(p.createdAt)}</div>
        </div>
        <div class="account-actions">
          ${!p.default
            ? html`<button class="btn btn-sm" @click=${() => this.switchAccount(p.id)}>Switch to</button>`
            : nothing
          }
          <button class="btn btn-sm btn-danger" @click=${() => this.removeAccount(p.id)}>Remove</button>
        </div>
      </div>
    `;
  }

  private renderLoginModal() {
    const flow = this.loginFlow!;
    return html`
      <div class="login-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.cancelLogin();
      }}>
        <div class="login-modal">
          <h3>🔑 Sign in with GitHub</h3>
          <p>Enter this code on GitHub to link your account:</p>

          <div class="device-code">${flow.userCode}</div>

          <ol class="login-steps">
            <li>Go to <a href="${flow.verificationUri}" target="_blank" rel="noopener">${flow.verificationUri}</a></li>
            <li>Paste the code above</li>
            <li>Authorize OpenRappter</li>
          </ol>

          <div class="login-status ${this.loginStatus}">
            ${this.loginStatus === 'pending'
              ? html`<span class="spinner-inline"></span>${this.loginMessage}`
              : this.loginStatus === 'success'
                ? html`✅ ${this.loginMessage}`
                : this.loginStatus === 'error'
                  ? html`❌ ${this.loginMessage}`
                  : nothing
            }
          </div>

          <div class="modal-actions">
            <a class="btn btn-primary" href="${flow.verificationUri}" target="_blank" rel="noopener">
              Open GitHub
            </a>
            <button class="btn" @click=${() => this.cancelLogin()}>Cancel</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-accounts': OpenRappterAccounts;
  }
}

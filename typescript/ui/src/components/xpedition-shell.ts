import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  FixtureReleaseRingAdapter,
  XpeditionWindowManager,
  allXpeditionApps,
  isOnboardingStep,
  isReleaseRing,
  isXpeditionAppId,
  loadXpeditionPreferences,
  saveXpeditionPreferences,
  xpeditionApp,
  xpeditionStorage,
  type ContrastPreference,
  type OnboardingStep,
  type OpenRappterView,
  type ReleaseRing,
  type ReleaseRingAdapter,
  type StorageLike,
  type XpeditionApp,
  type XpeditionAppId,
  type XpeditionDesktopState,
  type XpeditionPreferences,
  type XpeditionWindowState,
} from '../services/xpedition.js';
import type { OpenRappterXpeditionOnboarding } from './xpedition-onboarding.js';
import {
  isCompanyAppId,
  type CompanyAppId,
} from '../services/company-app-registry.js';
import {
  ActionBoundApprovalGate,
  livingCompanyScenario,
  type CompanyApprovalRequest,
  type ExternalAction,
} from '../services/living-company.js';
import {
  subscribeXpeditionDescriptors,
} from '../services/xpedition-extensions.js';
import type { CopilotReadinessSnapshot } from '../services/copilot-readiness.js';

interface DragState {
  id: string;
  offsetX: number;
  offsetY: number;
}

@customElement('openrappter-xpedition-shell')
export class OpenRappterXpeditionShell extends LitElement {
  static styles = css`
    :host {
      --xp-blue-900: #113f86;
      --xp-blue-700: #1c64b4;
      --xp-blue-500: #3886d5;
      --xp-green-700: #207444;
      --xp-green-500: #46a55f;
      --xp-paper: #f7fbff;
      --xp-ink: #10243d;
      --xp-muted: #4e647d;
      --xp-border: #204f8b;
      --xp-focus: #ffbd2e;
      display: block;
      min-height: 100vh;
      color: var(--xp-ink);
      font-family: Tahoma, Verdana, 'Segoe UI', sans-serif;
      font-size: clamp(14px, 0.82rem + 0.12vw, 17px);
    }

    :host([data-contrast='dark']) {
      --xp-paper: #152536;
      --xp-ink: #f3f8ff;
      --xp-muted: #b4c5d8;
      --xp-border: #78a9df;
    }

    :host([data-contrast='high-contrast']) {
      --xp-blue-900: #000;
      --xp-blue-700: #000;
      --xp-blue-500: #004ee8;
      --xp-green-700: #000;
      --xp-green-500: #006f21;
      --xp-paper: #000;
      --xp-ink: #fff;
      --xp-muted: #fff;
      --xp-border: #fff;
      --xp-focus: #ff0;
    }

    * { box-sizing: border-box; }

    .desktop {
      position: relative;
      width: 100vw;
      min-height: 100vh;
      overflow: hidden;
      outline: none;
      background:
        linear-gradient(rgba(14, 58, 91, 0.03), rgba(14, 58, 91, 0.08)),
        url('/xpedition-landscape.svg') center / cover no-repeat,
        #a8d9ef;
    }

    .brand {
      position: absolute;
      top: 1.1rem;
      right: 1.25rem;
      z-index: 1;
      max-width: 25rem;
      color: #113a63;
      text-align: right;
      text-shadow: 0 1px 1px rgba(255, 255, 255, 0.8);
      pointer-events: none;
    }

    .brand strong {
      display: block;
      font: 700 clamp(1rem, 2.2vw, 1.55rem)/1.1 Georgia, serif;
    }

    .brand span {
      display: block;
      margin-top: 0.2rem;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .offline-banner {
      position: absolute;
      top: 0.65rem;
      left: 50%;
      z-index: 15000;
      translate: -50%;
      max-width: min(42rem, calc(100vw - 2rem));
      padding: 0.6rem 0.9rem;
      border: 2px solid #8a260d;
      border-radius: 0.45rem;
      background: #fff2dd;
      color: #6a1d0b;
      box-shadow: 0 4px 20px rgba(31, 24, 14, 0.25);
      font-weight: 700;
    }

    .offline-banner button {
      margin-left: 0.6rem;
    }

    .offline-banner.copilot {
      top: 4rem;
      border-color: #8a5a0d;
      background: #fff8dc;
      color: #654207;
    }

    .shortcuts {
      position: absolute;
      top: 1.2rem;
      left: 0.8rem;
      bottom: 4rem;
      z-index: 2;
      display: grid;
      align-content: start;
      grid-template-columns: repeat(2, 6.4rem);
      gap: 0.45rem;
      overflow-y: auto;
      padding: 0.3rem;
    }

    .shortcut {
      width: 6.2rem;
      min-height: 5.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.32rem;
      border: 1px solid transparent;
      border-radius: 0.3rem;
      padding: 0.4rem 0.2rem;
      background: transparent;
      color: #0d2f50;
      font: 700 0.72rem/1.25 inherit;
      text-shadow: 0 1px white;
      cursor: default;
    }

    .shortcut:hover,
    .shortcut:focus-visible {
      border-color: rgba(23, 69, 116, 0.55);
      background: rgba(225, 245, 255, 0.55);
    }

    .app-glyph {
      width: 2.85rem;
      height: 2.85rem;
      display: grid;
      place-items: center;
      border: 1px solid rgba(4, 47, 88, 0.75);
      border-radius: 0.65rem 0.25rem 0.65rem 0.25rem;
      background:
        linear-gradient(145deg, rgba(255,255,255,.85), transparent 38%),
        linear-gradient(145deg, #56aee1, #1f6fa5 55%, #125637);
      color: white;
      box-shadow: 0 2px 5px rgba(3, 32, 57, 0.35);
      font: 800 0.78rem/1 Tahoma, sans-serif;
      text-shadow: 0 1px #143a60;
    }

    .shortcut:nth-child(2n) .app-glyph,
    .start-item:nth-child(2n) .app-glyph {
      background:
        linear-gradient(145deg, rgba(255,255,255,.85), transparent 38%),
        linear-gradient(145deg, #8cc86e, #368357 60%, #1a5e45);
    }

    .window {
      position: absolute;
      display: flex;
      min-width: 320px;
      min-height: 230px;
      flex-direction: column;
      overflow: hidden;
      border: 2px solid var(--xp-border);
      border-radius: 0.6rem 0.6rem 0.15rem 0.15rem;
      background: var(--xp-paper);
      box-shadow: 0 12px 38px rgba(2, 25, 54, 0.38);
    }

    .window.active {
      box-shadow: 0 18px 48px rgba(2, 25, 54, 0.52);
    }

    .window.maximized {
      inset: 0.45rem 0.45rem 3.65rem !important;
      width: auto !important;
      height: auto !important;
      border-radius: 0.4rem;
    }

    .titlebar {
      min-height: 2.4rem;
      display: flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0.25rem 0.35rem 0.25rem 0.6rem;
      background: linear-gradient(#4d96e1 0, #2167b7 52%, #164f99 53%, #2f75bf);
      color: white;
      cursor: move;
      user-select: none;
    }

    .window:not(.active) .titlebar {
      background: linear-gradient(#8aa8c7, #587a9d);
    }

    .title-glyph {
      width: 1.45rem;
      height: 1.45rem;
      display: grid;
      flex: 0 0 auto;
      place-items: center;
      border-radius: 0.3rem;
      background: #edf8ff;
      color: #14558f;
      font: 900 0.56rem/1 Tahoma, sans-serif;
    }

    .title {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      font-size: 0.79rem;
      font-weight: 800;
      text-overflow: ellipsis;
      text-shadow: 0 1px #0b4078;
      white-space: nowrap;
    }

    .window-controls {
      display: flex;
      gap: 0.18rem;
    }

    .window-control {
      width: 1.75rem;
      height: 1.65rem;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.8);
      border-radius: 0.25rem;
      padding: 0;
      background: linear-gradient(#65a5e6, #2c6bb6);
      color: white;
      font: 900 0.75rem/1 sans-serif;
      cursor: pointer;
    }

    .window-control.close {
      background: linear-gradient(#ee8c6c, #b52e1d);
    }

    .window-body {
      position: relative;
      min-height: 0;
      flex: 1;
      overflow: auto;
      background: var(--xp-paper);
      color: var(--xp-ink);
      --bg-primary: color-mix(in srgb, var(--xp-paper) 92%, #85a7c5);
      --bg-secondary: var(--xp-paper);
      --bg-tertiary: color-mix(in srgb, var(--xp-paper) 84%, #8fb1cf);
      --text-primary: var(--xp-ink);
      --text-secondary: var(--xp-muted);
      --accent: #2376be;
      --accent-foreground: white;
      --accent-hover: #155e9c;
      --error: #c53d46;
      --warning: #b36b00;
      --border: color-mix(in srgb, var(--xp-border) 45%, transparent);
      --shadow: rgba(5, 28, 54, 0.26);
    }

    .window-offline {
      padding: 0.42rem 0.7rem;
      border-bottom: 1px solid #a34a32;
      background: #fff0df;
      color: #76230e;
      font-size: 0.76rem;
      font-weight: 700;
    }

    .unavailable,
    .about,
    .ring-panel,
    .capability-note {
      margin: 1rem;
      padding: 1rem;
      border: 1px solid color-mix(in srgb, var(--xp-border) 60%, transparent);
      border-radius: 0.5rem;
      background: color-mix(in srgb, var(--xp-paper) 92%, #b5d8f5);
      line-height: 1.55;
    }

    .unavailable {
      border-color: #aa6c1a;
      background: #fff7dd;
      color: #5b3a08;
    }

    .capability-note {
      margin-bottom: 0;
      border-color: #7394b4;
      background: #eef7ff;
      color: #27445f;
      font-size: 0.78rem;
    }

    .about h2 {
      margin: 0 0 0.25rem;
      font-family: Georgia, serif;
      color: var(--xp-blue-900);
    }

    .about ul { padding-left: 1.2rem; }

    .ring-panel {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 0.65rem;
    }

    .ring-panel label {
      display: grid;
      gap: 0.25rem;
      font-weight: 700;
    }

    .ring-panel select {
      min-width: 10rem;
      padding: 0.45rem;
    }

    .warning {
      width: 100%;
      padding: 0.55rem;
      border: 1px solid #aa6c1a;
      border-radius: 0.35rem;
      background: #fff4ce;
      color: #684206;
      font-weight: 700;
    }

    .ring-message {
      width: 100%;
      font-size: 0.78rem;
      font-weight: 700;
    }

    .taskbar {
      position: absolute;
      inset: auto 0 0;
      z-index: 16000;
      height: 3.25rem;
      display: flex;
      align-items: stretch;
      gap: 0.3rem;
      padding-right: 0.35rem;
      border-top: 1px solid #81b9ed;
      background: linear-gradient(#3e91df 0, #1764b9 45%, #0d4d9f 100%);
      box-shadow: 0 -2px 8px rgba(8, 43, 82, 0.28);
    }

    .start-button {
      min-width: 7rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      border: 0;
      border-radius: 0 1rem 1rem 0;
      padding: 0 1rem 0 0.72rem;
      background: linear-gradient(#62bd6f, #258543 52%, #176b34);
      color: white;
      font: italic 800 1rem/1 Tahoma, sans-serif;
      text-shadow: 0 1px #184f28;
      cursor: pointer;
    }

    .start-mark {
      width: 1.7rem;
      height: 1.7rem;
      display: grid;
      place-items: center;
      border: 2px solid white;
      border-radius: 50% 45% 52% 40%;
      background: #1a6540;
      font: normal 900 0.72rem/1 Georgia, serif;
    }

    .tasks {
      min-width: 0;
      display: flex;
      flex: 1;
      gap: 0.25rem;
      align-items: center;
      overflow-x: auto;
    }

    .task {
      width: min(12rem, 18vw);
      min-width: 6rem;
      height: 2.35rem;
      overflow: hidden;
      border: 1px solid #134785;
      border-radius: 0.25rem;
      padding: 0 0.65rem;
      background: linear-gradient(#4b99df, #236db7);
      color: white;
      font: 700 0.72rem/1 inherit;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .task.active {
      background: linear-gradient(#2f70b5, #174e8e);
      box-shadow: inset 0 2px 4px rgba(3, 37, 73, 0.55);
    }

    .tray {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0 0.7rem;
      border-left: 1px solid #77bce9;
      background: linear-gradient(#31a4d9, #1477b7);
      color: white;
      font-size: 0.7rem;
    }

    .connection-state {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .connection-symbol {
      width: 0.72rem;
      height: 0.72rem;
      border: 2px solid white;
      border-radius: 50%;
      background: #39a957;
    }

    .connection-symbol.offline {
      background: #b83228;
    }

    .clock {
      min-width: 4.6rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .start-menu {
      position: absolute;
      left: 0.35rem;
      bottom: 3.1rem;
      z-index: 17000;
      width: min(31rem, calc(100vw - 0.7rem));
      overflow: hidden;
      border: 2px solid #174e94;
      border-radius: 0.65rem 0.65rem 0.1rem 0.1rem;
      background: white;
      box-shadow: 0 14px 45px rgba(4, 29, 60, 0.48);
      color: #143050;
    }

    .start-header {
      display: flex;
      align-items: center;
      gap: 0.8rem;
      padding: 0.8rem 1rem;
      background: linear-gradient(135deg, #1d63b1, #3f91db);
      color: white;
    }

    .profile-mark {
      width: 3.25rem;
      height: 3.25rem;
      display: grid;
      place-items: center;
      border: 2px solid white;
      border-radius: 0.55rem;
      background: linear-gradient(145deg, #87d285, #23734e);
      font: 900 1.05rem/1 Georgia, serif;
    }

    .start-header strong {
      display: block;
      font-family: Georgia, serif;
    }

    .start-header span {
      font-size: 0.72rem;
      opacity: 0.9;
    }

    .start-grid {
      display: grid;
      grid-template-columns: 1.25fr 0.9fr;
    }

    .start-apps {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.2rem;
      padding: 0.65rem;
    }

    .start-item {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      min-width: 0;
      border: 0;
      border-radius: 0.35rem;
      padding: 0.45rem;
      background: transparent;
      color: inherit;
      font: 700 0.72rem/1.2 inherit;
      text-align: left;
      cursor: pointer;
    }

    .start-item:hover,
    .start-item:focus-visible {
      background: #d8ebff;
    }

    .start-item .app-glyph {
      width: 2.2rem;
      height: 2.2rem;
      flex: 0 0 auto;
      font-size: 0.6rem;
    }

    .start-side {
      display: grid;
      align-content: start;
      gap: 0.35rem;
      padding: 0.75rem;
      border-left: 1px solid #a8c7e6;
      background: #dfefff;
    }

    .start-side button {
      border: 0;
      border-radius: 0.35rem;
      padding: 0.6rem;
      background: transparent;
      color: #173f6a;
      font: 700 0.73rem/1.2 inherit;
      text-align: left;
      cursor: pointer;
    }

    .start-side button:hover,
    .start-side button:focus-visible {
      background: white;
    }

    button,
    select {
      font-family: inherit;
    }

    button:focus-visible,
    select:focus-visible,
    .window:focus-visible {
      outline: 3px solid var(--xp-focus);
      outline-offset: 2px;
    }

    @media (max-width: 760px) {
      .brand {
        top: 0.6rem;
        right: 0.7rem;
      }
      .brand span { display: none; }
      .shortcuts {
        top: 3.1rem;
        right: 0;
        bottom: 4.2rem;
        grid-template-columns: repeat(auto-fit, minmax(5.6rem, 1fr));
      }
      .shortcut {
        width: auto;
      }
      .window,
      .window.maximized {
        inset: 0.45rem 0.45rem 3.7rem !important;
        width: auto !important;
        height: auto !important;
        min-width: 0;
        border-radius: 0.4rem;
      }
      .taskbar { height: 3.45rem; }
      .start-button {
        min-width: 4rem;
        padding-right: 0.7rem;
        font-size: 0;
      }
      .start-mark { font-size: 0.72rem; }
      .task {
        width: 3.2rem;
        min-width: 3.2rem;
        padding: 0;
        font-size: 0;
        text-align: center;
      }
      .task::first-letter { font-size: 0.75rem; }
      .tray .connection-state span:last-child { display: none; }
      .start-grid { grid-template-columns: 1fr; }
      .start-apps { grid-template-columns: 1fr 1fr; }
      .start-side {
        grid-template-columns: 1fr 1fr;
        border-top: 1px solid #a8c7e6;
        border-left: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition: none !important;
        animation: none !important;
      }
    }

    @media (forced-colors: active) {
      .desktop { background: Canvas; }
      .window, .taskbar, .start-menu { border: 2px solid CanvasText; }
      .titlebar, .taskbar, .start-header { background: Highlight; color: HighlightText; }
    }
  `;

  @property({ type: Boolean }) connected = false;
  @property({ type: String }) connectionError = '';
  @property({ attribute: false }) copilotReadiness: CopilotReadinessSnapshot = {
    state: 'unknown',
    message: 'Copilot readiness has not been checked.',
  };
  @property({ attribute: false }) ringAdapter: ReleaseRingAdapter =
    new FixtureReleaseRingAdapter();
  @property({ attribute: false }) storage: StorageLike = xpeditionStorage();

  @state() private desktopState: XpeditionDesktopState = {
    activeWindowId: null,
    windows: [],
  };
  @state() private startOpen = false;
  @state() private now = new Date();
  @state() private preferences: XpeditionPreferences = {
    ...DEFAULT_XPEDITION_PREFERENCES,
  };
  @state() private pendingRing: ReleaseRing = 'stable';
  @state() private ringMessage = '';
  @state() private pendingRingApproval:
    | { request: CompanyApprovalRequest; ring: ReleaseRing }
    | null = null;
  private manager = new XpeditionWindowManager((state) => {
    this.desktopState = state;
  });
  private clockTimer?: ReturnType<typeof setInterval>;
  private drag: DragState | null = null;
  private unsubscribeExtensions?: () => void;
  @state() private extensionRevision = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.preferences = loadXpeditionPreferences(this.storage);
    this.pendingRing = this.preferences.releaseRing;
    this.setAttribute('data-contrast', this.preferences.contrast);
    this.clockTimer = setInterval(() => {
      this.now = new Date();
    }, 30_000);
    this.unsubscribeExtensions = subscribeXpeditionDescriptors(() => {
      this.extensionRevision++;
      const registered = new Set(allXpeditionApps().map((app) => app.id));
      for (const window of this.manager.state.windows) {
        if (!registered.has(window.appId)) this.manager.close(window.id);
      }
    });
    globalThis.addEventListener('pointermove', this.handlePointerMove);
    globalThis.addEventListener('pointerup', this.handlePointerUp);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.unsubscribeExtensions?.();
    globalThis.removeEventListener('pointermove', this.handlePointerMove);
    globalThis.removeEventListener('pointerup', this.handlePointerUp);
  }

  getDesktopState(): Record<string, unknown> {
    const onboarding = this.shadowRoot?.querySelector(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding | null;
    return {
      schema: 'openrappter-xpedition-state/1.0',
      shell: 'xpedition',
      connected: this.connected,
      copilotReadiness: { ...this.copilotReadiness },
      onboarding: this.preferences.onboardingCompleted
        ? { completed: true, step: null }
        : { completed: false, step: onboarding?.currentStep ?? 'welcome' },
      startMenuOpen: this.startOpen,
      activeWindowId: this.desktopState.activeWindowId,
      windows: this.desktopState.windows.map((window) => ({
        id: window.id,
        appId: window.appId,
        title: window.title,
        minimized: window.minimized,
        maximized: window.maximized,
        active: window.id === this.desktopState.activeWindowId,
      })),
      livingCompany: livingCompanyScenario.snapshot(),
    };
  }

  openApp(appId: XpeditionAppId): Record<string, unknown> {
    if (!isXpeditionAppId(appId)) throw new Error(`Unknown XPedition app: ${String(appId)}`);
    this.startOpen = false;
    const window = this.manager.open(appId);
    void this.updateComplete.then(() => {
      this.shadowRoot?.querySelector<HTMLElement>(`#${window.id}`)?.focus();
    });
    return this.getDesktopState();
  }

  openView(view: OpenRappterView): Record<string, unknown> {
    const app = this.appCatalog.find((candidate) => candidate.view === view);
    if (!app) throw new Error(`No XPedition app maps to view: ${view}`);
    return this.openApp(app.id);
  }

  focusWindow(id: string): Record<string, unknown> {
    if (!this.manager.focus(id)) throw new Error(`Unknown XPedition window: ${id}`);
    return this.getDesktopState();
  }

  closeWindow(id: string): Record<string, unknown> {
    if (!this.manager.close(id)) throw new Error(`Unknown XPedition window: ${id}`);
    return this.getDesktopState();
  }

  selectOnboardingStep(step: OnboardingStep): Record<string, unknown> {
    if (!isOnboardingStep(step)) throw new Error(`Unknown onboarding step: ${String(step)}`);
    const onboarding = this.shadowRoot?.querySelector(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding | null;
    if (!onboarding) throw new Error('Onboarding is not active.');
    onboarding.selectStep(step);
    return this.getDesktopState();
  }

  companyState(): Record<string, unknown> {
    return livingCompanyScenario.snapshot() as unknown as Record<string, unknown>;
  }

  async runCompanyScenario(
    operation: 'start' | 'step' | 'run' | 'reset' | 'replay',
  ): Promise<Record<string, unknown>> {
    if (operation === 'start') livingCompanyScenario.start();
    if (operation === 'step') await livingCompanyScenario.step();
    if (operation === 'run') await livingCompanyScenario.runUntilBlocked();
    if (operation === 'reset') livingCompanyScenario.reset();
    if (operation === 'replay') {
      livingCompanyScenario.reset();
      livingCompanyScenario.start();
      await livingCompanyScenario.runUntilBlocked();
    }
    this.notifyCompanyChange();
    return livingCompanyScenario.snapshot() as unknown as Record<string, unknown>;
  }

  approveCompanyAction(
    requestId: string,
    action: ExternalAction,
    approved: boolean,
    humanConfirmed: boolean,
  ): Record<string, unknown> {
    const result = livingCompanyScenario.approve(
      requestId,
      action,
      approved,
      humanConfirmed,
    );
    this.notifyCompanyChange();
    return result as unknown as Record<string, unknown>;
  }

  private persistPreferences(changes: Partial<XpeditionPreferences>): void {
    this.preferences = { ...this.preferences, ...changes, version: 1 };
    saveXpeditionPreferences(this.storage, this.preferences);
    this.setAttribute('data-contrast', this.preferences.contrast);
    this.dispatchEvent(new CustomEvent('xpedition-preferences', {
      detail: this.preferences,
      bubbles: true,
      composed: true,
    }));
  }

  private notifyCompanyChange(): void {
    globalThis.dispatchEvent(
      new CustomEvent('openrappter-living-company-change'),
    );
    this.requestUpdate();
  }

  private finishOnboarding(event: CustomEvent<{ releaseRing: ReleaseRing }>): void {
    this.persistPreferences({
      onboardingCompleted: true,
      releaseRing: event.detail.releaseRing,
    });
    this.openApp('observe');
  }

  private switchLegacy(): void {
    this.persistPreferences({ shell: 'legacy' });
    this.dispatchEvent(new CustomEvent('switch-shell', {
      detail: { shell: 'legacy' },
      bubbles: true,
      composed: true,
    }));
  }

  private cycleContrast(): void {
    const order: ContrastPreference[] = ['light', 'dark', 'high-contrast'];
    const next = order[(order.indexOf(this.preferences.contrast) + 1) % order.length];
    this.persistPreferences({ contrast: next });
  }

  private async applyReleaseRing(): Promise<void> {
    if (!this.pendingRingApproval) return;
    const pending = this.pendingRingApproval;
    this.settingsApprovals.resolve(
      pending.request.id,
      'release.apply',
      true,
      true,
    );
    this.settingsApprovals.consume(
      pending.request.id,
      'release.apply',
    );
    const result = await this.ringAdapter.apply(pending.ring);
    this.ringMessage = result.message;
    if (result.status === 'applied') {
      this.persistPreferences({ releaseRing: result.ring });
    }
    this.pendingRingApproval = null;
  }

  private readonly settingsApprovals = new ActionBoundApprovalGate();

  private requestReleaseRingApproval(): void {
    this.pendingRingApproval = {
      request: this.settingsApprovals.request(
        'release.apply',
        `Apply ${this.pendingRing} release ring`,
      ),
      ring: this.pendingRing,
    };
  }

  private rejectReleaseRingApproval(): void {
    if (!this.pendingRingApproval) return;
    this.settingsApprovals.resolve(
      this.pendingRingApproval.request.id,
      'release.apply',
      false,
      true,
    );
    this.ringMessage = 'Release-ring Apply / Update was rejected. Nothing changed.';
    this.pendingRingApproval = null;
  }

  private handleDesktopKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.startOpen) {
      event.preventDefault();
      this.startOpen = false;
      return;
    }
    if (event.altKey && event.key === 'Tab') {
      event.preventDefault();
      this.manager.cycleFocus(event.shiftKey);
      return;
    }
    if (event.ctrlKey && event.code === 'Space') {
      event.preventDefault();
      this.startOpen = !this.startOpen;
      return;
    }
    if (event.key === 'F6') {
      event.preventDefault();
      this.manager.cycleFocus(event.shiftKey);
    }
  }

  private handleShortcutKeydown(
    event: KeyboardEvent,
    index: number,
  ): void {
    const shortcuts = this.appCatalog.filter((app) => app.desktop);
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(shortcuts.length - 1, index + 2);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 2);
    else if (event.key === 'ArrowRight') next = Math.min(shortcuts.length - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else return;
    event.preventDefault();
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.shortcut')[next]?.focus();
  }

  private beginDrag(event: PointerEvent, window: XpeditionWindowState): void {
    if ((event.target as HTMLElement).closest('button') || window.maximized) return;
    const bounds = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    this.drag = {
      id: window.id,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    };
    this.manager.focus(window.id);
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.manager.move(
      this.drag.id,
      event.clientX - this.drag.offsetX,
      event.clientY - this.drag.offsetY,
    );
  };

  private handlePointerUp = (): void => {
    this.drag = null;
  };

  private renderAppContent(app: XpeditionApp): unknown {
    if (app.routeId) {
      const route = xpeditionApp(app.routeId);
      if (!route) {
        return html`
          <div class="unavailable" role="status">
            Approved local route ${app.routeId} is unavailable in this build.
          </div>
        `;
      }
      return html`
        <div class="capability-note" role="note">
          Data-only descriptor mapped to first-party route
          <code>${app.routeId}</code>.
          ${app.capabilityIds?.length
            ? html`
                Declared public capabilities:
                ${app.capabilityIds.map((capability) =>
                  html`<code>${capability}</code>`)}
              `
            : html`No optional capability selectors were requested.`}
          Descriptor metadata never activates controls.
        </div>
        ${this.renderAppContent(route)}
      `;
    }
    if (app.unavailableReason) {
      return html`
        <div class="unavailable" role="status">
          <strong>${app.title} is unavailable in this build.</strong>
          <p>${app.unavailableReason}</p>
        </div>
      `;
    }
    if (isCompanyAppId(app.id)) {
      return html`
        <openrappter-company-app
          .appId=${app.id as CompanyAppId}
          @open-xpedition-app=${(event: CustomEvent<{ appId: XpeditionAppId }>) => {
            if (isXpeditionAppId(event.detail.appId)) {
              this.openApp(event.detail.appId);
            }
          }}
        ></openrappter-company-app>
      `;
    }
    if (app.id === 'help') {
      return html`
        <article class="about">
          <h2>OpenRappter Personal</h2>
          <p>
            <strong>Rapter's Clever Girl Edition · Windows XPedition</strong>
            · user slug <code>rapters-clevergirledition</code>
          </p>
          <p>
            A local-first desktop shell for OpenRappter. All operational
            windows below reuse the existing gateway RPC client and Lit
            product surfaces.
          </p>
          <p>
            <strong>Open-core boundary:</strong> this repository is licensed
            under the <strong>Apache License 2.0</strong>; your rights to the
            open core follow the repository's <code>LICENSE</code> and
            <code>NOTICE</code> files. OpenRappter is not presented as MIT.
          </p>
          <p>
            Hosted, licensed business-organism tenancy and training belong to
            the separate private RapterOS SaaS. OpenRappter Personal contains
            no tenant provisioning, billing, entitlement, or private
            control-plane implementation.
          </p>
          <ul>
            <li><kbd>Ctrl</kbd> + <kbd>Space</kbd>: open Start</li>
            <li><kbd>Alt</kbd> + <kbd>Tab</kbd> or <kbd>F6</kbd>: cycle windows</li>
            <li><kbd>Escape</kbd>: close Start</li>
          </ul>
          <p>
            Use <strong>Legacy OpenRappter</strong> from Start at any time
            during the migration release. Saved OpenRappter state is never deleted.
          </p>
        </article>
      `;
    }
    const surface = (() => {
      switch (app.view) {
        case 'surgeon': return html`<openrappter-surgeon></openrappter-surgeon>`;
        case 'chat': return html`<openrappter-chat></openrappter-chat>`;
        case 'show-and-tell': return html`<openrappter-show-and-tell></openrappter-show-and-tell>`;
        case 'agents': return html`<openrappter-agents></openrappter-agents>`;
        case 'showcase': return html`<openrappter-showcase></openrappter-showcase>`;
        case 'logs': return html`<openrappter-logs></openrappter-logs>`;
        case 'skills': return html`<openrappter-skills></openrappter-skills>`;
        case 'channels': return html`<openrappter-channels></openrappter-channels>`;
        case 'sessions': return html`<openrappter-sessions></openrappter-sessions>`;
        case 'cron': return html`<openrappter-cron></openrappter-cron>`;
        case 'devices': return html`<openrappter-devices></openrappter-devices>`;
        case 'presence': return html`<openrappter-presence></openrappter-presence>`;
        case 'debug': return html`<openrappter-debug></openrappter-debug>`;
        case 'zen': return html`<openrappter-zen></openrappter-zen>`;
        case 'accounts': return html`<openrappter-accounts></openrappter-accounts>`;
        case 'config': return html`<openrappter-config></openrappter-config>`;
        default: return html`<div class="unavailable">No product surface is registered for ${app.title}.</div>`;
      }
    })();
    if (app.id === 'settings') {
      return html`
        <section class="ring-panel" aria-labelledby="ring-heading">
          <label id="ring-heading">
            Release ring
            <select
              ?disabled=${Boolean(this.pendingRingApproval)}
              .value=${this.pendingRing}
              @change=${(event: Event) => {
                const value = (event.target as HTMLSelectElement).value;
                if (isReleaseRing(value)) {
                  this.pendingRing = value;
                  this.ringMessage = '';
                }
              }}
            >
              ${['stable', 'beta', 'canary', 'alpha', 'nightly'].map(
                (ring) => html`<option value=${ring}>${ring}</option>`,
              )}
            </select>
          </label>
          <button
            ?disabled=${this.pendingRing === this.preferences.releaseRing}
            @click=${this.requestReleaseRingApproval}
          >Request Apply / Update</button>
          ${this.pendingRing !== 'stable'
            ? html`
                <div class="warning" role="alert">
                  ${this.pendingRing} may be less stable or older. Selection
                  alone changes nothing; Apply / Update must succeed.
                </div>
              `
            : nothing}
          ${this.ringMessage
            ? html`<div class="ring-message" role="status" aria-live="polite">${this.ringMessage}</div>`
            : nothing}
          ${this.pendingRingApproval
            ? html`
                <div class="warning" role="alert">
                  Confirm the action-bound request:
                  <code>${this.pendingRingApproval.request.actionFingerprint}</code>
                  <div class="actions" style="margin-top:.5rem">
                    <button
                      data-desktop-sensitive="company-approval"
                      @click=${() => void this.applyReleaseRing()}
                    >Confirm Apply / Update</button>
                    <button
                      data-desktop-sensitive="company-approval"
                      @click=${this.rejectReleaseRingApproval}
                    >Reject</button>
                  </div>
                </div>
              `
            : nothing}
        </section>
        ${surface}
      `;
    }
    if (app.id === 'observe') {
      return html`
        <div class="capability-note" role="note">
          This is the real live patient/Observe surface. Importing history and
          generating inert Clever Girl proposals remains in
          <code>openrappter clever-girl observe</code> until a bounded UI RPC
          is available.
        </div>
        ${surface}
      `;
    }
    if (app.id === 'flight') {
      return html`
        <div class="capability-note" role="note">
          This window shows the gateway's real live log stream. Flight Recorder
          trace export and replay remain available through
          <code>openrappter flight</code>; this build exposes no trace-export UI RPC.
        </div>
        ${surface}
      `;
    }
    return surface;
  }

  private renderWindow(window: XpeditionWindowState) {
    const app = xpeditionApp(window.appId);
    if (!app) return nothing;
    if (window.minimized) return nothing;
    const style = window.maximized
      ? `z-index:${window.zIndex}`
      : `z-index:${window.zIndex};left:${window.x}px;top:${window.y}px;width:min(${window.width}px,calc(100vw - ${window.x + 12}px));height:min(${window.height}px,calc(100vh - ${window.y + 66}px))`;
    return html`
      <section
        id=${window.id}
        class="window ${window.maximized ? 'maximized' : ''} ${window.id === this.desktopState.activeWindowId ? 'active' : ''}"
        style=${style}
        role="dialog"
        aria-modal="false"
        aria-label=${window.title}
        tabindex="-1"
        ?inert=${!this.preferences.onboardingCompleted}
        aria-hidden=${this.preferences.onboardingCompleted ? 'false' : 'true'}
        @pointerdown=${() => this.manager.focus(window.id)}
      >
        <header
          class="titlebar"
          @dblclick=${() => this.manager.toggleMaximize(window.id)}
          @pointerdown=${(event: PointerEvent) => this.beginDrag(event, window)}
        >
          <span class="title-glyph" aria-hidden="true">${app.glyph}</span>
          <span class="title">${window.title}</span>
          <span class="window-controls">
            <button
              class="window-control"
              aria-label="Minimize ${window.title}"
              title="Minimize"
              @click=${() => this.manager.minimize(window.id)}
            >—</button>
            <button
              class="window-control"
              aria-label="${window.maximized ? 'Restore' : 'Maximize'} ${window.title}"
              title=${window.maximized ? 'Restore' : 'Maximize'}
              @click=${() => this.manager.toggleMaximize(window.id)}
            >${window.maximized ? '❐' : '□'}</button>
            <button
              class="window-control close"
              aria-label="Close ${window.title}"
              title="Close"
              @click=${() => this.manager.close(window.id)}
            >×</button>
          </span>
        </header>
        <div class="window-body">
          ${!this.connected && app.view
            ? html`
                <div class="window-offline" role="status">
                  Gateway disconnected. This real surface may be read-only or
                  show its own retryable error until connection returns.
                </div>
              `
            : nothing}
          ${this.renderAppContent(app)}
        </div>
      </section>
    `;
  }

  private renderStartMenu() {
    if (!this.startOpen) return nothing;
    return html`
      <section
        class="start-menu"
        role="menu"
        aria-label="Start menu"
        ?inert=${!this.preferences.onboardingCompleted}
        aria-hidden=${this.preferences.onboardingCompleted ? 'false' : 'true'}
      >
        <header class="start-header">
          <span class="profile-mark" aria-hidden="true">R</span>
          <span>
            <strong>OpenRappter Personal</strong>
            Rapter's Clever Girl Edition · Windows XPedition
          </span>
        </header>
        <div class="start-grid">
          <div class="start-apps">
            ${this.appCatalog.map((app) => html`
              <button
                class="start-item"
                role="menuitem"
                @click=${() => this.openApp(app.id)}
              >
                <span class="app-glyph" aria-hidden="true">${app.glyph}</span>
                <span>${app.title}</span>
              </button>
            `)}
          </div>
          <div class="start-side">
            <button role="menuitem" @click=${() => this.openApp('settings')}>Settings & Release Ring</button>
            <button role="menuitem" @click=${this.cycleContrast}>
              Contrast: ${this.preferences.contrast}
            </button>
            <button role="menuitem" @click=${() => this.openApp('help')}>Help & About</button>
            <button role="menuitem" @click=${this.switchLegacy}>Legacy OpenRappter</button>
          </div>
        </div>
      </section>
    `;
  }

  render() {
    const desktopApps = this.appCatalog.filter((app) => app.desktop);
    return html`
      <main
        class="desktop"
        role="application"
        aria-label="OpenRappter Personal, Rapter's Clever Girl Edition, Windows XPedition desktop"
        tabindex="0"
        @keydown=${this.handleDesktopKeydown}
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) this.startOpen = false;
        }}
      >
        <div class="brand" aria-hidden="true">
          <strong>OpenRappter Personal</strong>
          <span>Rapter's Clever Girl Edition · Windows XPedition</span>
        </div>

        ${!this.connected && this.preferences.onboardingCompleted
          ? html`
              <div class="offline-banner" role="alert" aria-live="assertive">
                Gateway offline — ${this.connectionError || 'connection lost.'}
                <button @click=${() => this.dispatchEvent(new CustomEvent('retry-gateway', { bubbles: true, composed: true }))}>
                  Retry
                </button>
              </div>
            `
          : nothing}

        ${this.connected &&
        this.preferences.onboardingCompleted &&
        this.copilotReadiness.state !== 'ready'
          ? html`
              <div class="offline-banner copilot" role="alert" aria-live="assertive">
                Copilot ${this.copilotReadiness.state}: ${this.copilotReadiness.message}
                ${this.copilotReadiness.state === 'needs-sign-in'
                  ? html`
                      <button
                        data-desktop-sensitive="copilot-sign-in"
                        @click=${() => this.dispatchEvent(new CustomEvent(
                        'copilot-sign-in',
                        { bubbles: true, composed: true },
                      ))}
                      >Sign in</button>
                    `
                  : html`
                      <button @click=${() => this.dispatchEvent(new CustomEvent(
                        'check-copilot',
                        { bubbles: true, composed: true },
                      ))}>Check again</button>
                    `}
              </div>
            `
          : nothing}

        <nav
          class="shortcuts"
          aria-label="Desktop shortcuts"
          ?inert=${!this.preferences.onboardingCompleted}
          aria-hidden=${this.preferences.onboardingCompleted ? 'false' : 'true'}
        >
          ${desktopApps.map((app, index) => html`
            <button
              class="shortcut"
              aria-label="Open ${app.title}"
              @dblclick=${() => this.openApp(app.id)}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') this.openApp(app.id);
                else this.handleShortcutKeydown(event, index);
              }}
            >
              <span class="app-glyph" aria-hidden="true">${app.glyph}</span>
              <span>${app.shortTitle}</span>
            </button>
          `)}
        </nav>

        ${this.desktopState.windows.map((window) => this.renderWindow(window))}
        ${this.renderStartMenu()}

        <footer
          class="taskbar"
          aria-label="Taskbar"
          ?inert=${!this.preferences.onboardingCompleted}
          aria-hidden=${this.preferences.onboardingCompleted ? 'false' : 'true'}
        >
          <button
            class="start-button"
            aria-haspopup="menu"
            aria-expanded=${this.startOpen}
            @click=${() => {
              this.startOpen = !this.startOpen;
            }}
          >
            <span class="start-mark" aria-hidden="true">R</span>
            Start
          </button>
          <div class="tasks" role="list" aria-label="Open windows">
            ${this.desktopState.windows.map((window) => html`
              <button
                class="task ${window.id === this.desktopState.activeWindowId && !window.minimized ? 'active' : ''}"
                role="listitem"
                aria-label="${window.minimized ? 'Restore' : 'Focus'} ${window.title}"
                @click=${() => {
                  if (window.id === this.desktopState.activeWindowId && !window.minimized) {
                    this.manager.minimize(window.id);
                  } else {
                    this.manager.focus(window.id);
                  }
                }}
              >${window.title}</button>
            `)}
          </div>
          <div class="tray" aria-label="System tray">
            <span class="connection-state">
              <span class="connection-symbol ${this.connected ? '' : 'offline'}" aria-hidden="true"></span>
              <span>${this.connected ? 'Gateway connected' : 'Gateway offline'}</span>
            </span>
            <span class="connection-state" aria-label="Copilot readiness">
              <span
                class="connection-symbol ${this.copilotReadiness.state === 'ready' ? '' : 'offline'}"
                aria-hidden="true"
              ></span>
              <span>Copilot ${this.copilotReadiness.state}</span>
            </span>
            <time class="clock" datetime=${this.now.toISOString()}>
              ${this.now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
        </footer>

        ${this.preferences.onboardingCompleted
          ? nothing
          : html`
              <openrappter-xpedition-onboarding
                .connected=${this.connected}
                .connectionError=${this.connectionError}
                .copilotReadiness=${this.copilotReadiness}
                .ringAdapter=${this.ringAdapter}
                @retry-gateway=${(event: Event) => {
                  event.stopPropagation();
                  this.dispatchEvent(new CustomEvent('retry-gateway', { bubbles: true, composed: true }));
                }}
                @switch-shell=${(event: Event) => {
                  event.stopPropagation();
                  this.switchLegacy();
                }}
                @check-copilot=${(event: Event) => {
                  event.stopPropagation();
                  this.dispatchEvent(new CustomEvent('check-copilot', {
                    bubbles: true,
                    composed: true,
                  }));
                }}
                @copilot-sign-in=${(event: Event) => {
                  event.stopPropagation();
                  this.dispatchEvent(new CustomEvent('copilot-sign-in', {
                    bubbles: true,
                    composed: true,
                  }));
                }}
                @onboarding-complete=${this.finishOnboarding}
              ></openrappter-xpedition-onboarding>
            `}
      </main>
    `;
  }

  private get appCatalog(): readonly XpeditionApp[] {
    void this.extensionRevision;
    return allXpeditionApps();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-xpedition-shell': OpenRappterXpeditionShell;
  }
}

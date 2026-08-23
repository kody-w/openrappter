import {
  COMPANY_APP_IDS,
  COMPANY_APP_REGISTRATIONS,
} from './company-app-registry.js';
import {
  isRegisteredXpeditionExtensionId,
  listXpeditionExtensions,
  xpeditionExtension,
  type XpeditionExtensionId,
} from './xpedition-extensions.js';

export const XPEDITION_APP_IDS = [
  'observe',
  'chat',
  'show-and-tell',
  'agents',
  'showcase',
  'flight',
  'skills',
  'channels',
  'sessions',
  'cron',
  'devices',
  'presence',
  'debug',
  'zen',
  'accounts',
  'memory',
  'settings',
  'terminal',
  'help',
  ...COMPANY_APP_IDS,
] as const;

export type XpeditionAppId =
  | (typeof XPEDITION_APP_IDS)[number]
  | XpeditionExtensionId;
export type OpenRappterView =
  | 'surgeon'
  | 'chat'
  | 'show-and-tell'
  | 'channels'
  | 'sessions'
  | 'cron'
  | 'config'
  | 'logs'
  | 'agents'
  | 'skills'
  | 'devices'
  | 'presence'
  | 'debug'
  | 'showcase'
  | 'zen'
  | 'accounts';

export interface XpeditionApp {
  id: XpeditionAppId;
  title: string;
  shortTitle: string;
  description: string;
  glyph: string;
  view?: OpenRappterView;
  unavailableReason?: string;
  extensionElement?: `${string}-${string}`;
  dataSeams?: readonly string[];
  desktop: boolean;
}

export const XPEDITION_APPS: readonly XpeditionApp[] = [
  {
    id: 'observe',
    title: 'Clever Girl Observe',
    shortTitle: 'Observe',
    description: 'Inspect the live OpenRappter patient and evidence-backed signals.',
    glyph: 'CG',
    view: 'surgeon',
    desktop: true,
  },
  {
    id: 'chat',
    title: 'Chat & Agents',
    shortTitle: 'Chat',
    description: 'Talk to the connected OpenRappter runtime.',
    glyph: '···',
    view: 'chat',
    desktop: true,
  },
  {
    id: 'show-and-tell',
    title: 'Show-and-Tell',
    shortTitle: 'Show & Tell',
    description: 'Record and review a consent-gated local workflow.',
    glyph: 'REC',
    view: 'show-and-tell',
    desktop: false,
  },
  {
    id: 'agents',
    title: 'Agent Explorer',
    shortTitle: 'Agents',
    description: 'Browse the agents registered by the gateway.',
    glyph: 'A',
    view: 'agents',
    desktop: false,
  },
  {
    id: 'showcase',
    title: 'Showcase',
    shortTitle: 'Showcase',
    description: 'Run the real deterministic orchestration showcases.',
    glyph: '▶',
    view: 'showcase',
    desktop: true,
  },
  {
    id: 'flight',
    title: 'Flight Recorder',
    shortTitle: 'Flight',
    description: 'Watch truthful gateway log events and execution evidence.',
    glyph: 'FR',
    view: 'logs',
    desktop: true,
  },
  {
    id: 'skills',
    title: 'Skills',
    shortTitle: 'Skills',
    description: 'Discover and manage installed local skills.',
    glyph: '◇',
    view: 'skills',
    desktop: true,
  },
  {
    id: 'channels',
    title: 'Channels',
    shortTitle: 'Channels',
    description: 'Configure real messaging channel connections.',
    glyph: '↗',
    view: 'channels',
    desktop: false,
  },
  {
    id: 'sessions',
    title: 'Sessions',
    shortTitle: 'Sessions',
    description: 'Browse real gateway chat sessions.',
    glyph: 'S',
    view: 'sessions',
    desktop: false,
  },
  {
    id: 'cron',
    title: 'Cron Jobs',
    shortTitle: 'Cron',
    description: 'Manage scheduled OpenRappter jobs.',
    glyph: 'T',
    view: 'cron',
    desktop: false,
  },
  {
    id: 'devices',
    title: 'Devices',
    shortTitle: 'Devices',
    description: 'Inspect connected gateway devices.',
    glyph: 'D',
    view: 'devices',
    desktop: false,
  },
  {
    id: 'presence',
    title: 'System Health',
    shortTitle: 'Health',
    description: 'Inspect gateway health and presence.',
    glyph: '+',
    view: 'presence',
    desktop: false,
  },
  {
    id: 'debug',
    title: 'Debug Console',
    shortTitle: 'Debug',
    description: 'Use the existing bounded RPC debug surface.',
    glyph: '{ }',
    view: 'debug',
    desktop: false,
  },
  {
    id: 'zen',
    title: 'Zen',
    shortTitle: 'Zen',
    description: 'Open the existing quiet-focus surface.',
    glyph: '○',
    view: 'zen',
    desktop: false,
  },
  {
    id: 'accounts',
    title: 'GitHub Accounts',
    shortTitle: 'Accounts',
    description: 'Manage existing GitHub Copilot account connections.',
    glyph: '@',
    view: 'accounts',
    desktop: false,
  },
  {
    id: 'memory',
    title: 'Memory',
    shortTitle: 'Memory',
    description: 'OpenRappter local memory status.',
    glyph: 'M',
    unavailableReason:
      'This gateway does not yet expose a bounded Memory UI RPC. Your existing local memory is unchanged and remains available through the Memory agent and CLI.',
    desktop: false,
  },
  {
    id: 'settings',
    title: 'Settings & Release Ring',
    shortTitle: 'Settings',
    description: 'Configure OpenRappter and choose an update ring.',
    glyph: '⚙',
    view: 'config',
    desktop: true,
  },
  {
    id: 'terminal',
    title: 'Terminal / Shell',
    shortTitle: 'Terminal',
    description: 'Run approved shell operations.',
    glyph: '>_',
    unavailableReason:
      'No standalone terminal is exposed by this gateway. Shell operations remain available only through the authorized Shell agent and its approval policy.',
    desktop: false,
  },
  {
    id: 'help',
    title: 'Help & About',
    shortTitle: 'Help',
    description: "About OpenRappter Personal and Rapter's Clever Girl Edition.",
    glyph: '?',
    desktop: false,
  },
  ...COMPANY_APP_REGISTRATIONS,
] as const;

export function isXpeditionAppId(value: unknown): value is XpeditionAppId {
  return (
    typeof value === 'string' &&
    (XPEDITION_APP_IDS as readonly string[]).includes(value)
  ) || isRegisteredXpeditionExtensionId(value);
}

export function allXpeditionApps(): readonly XpeditionApp[] {
  return [
    ...XPEDITION_APPS,
    ...listXpeditionExtensions().map((extension) => ({
      id: extension.id,
      title: extension.title,
      shortTitle: extension.shortTitle,
      description: extension.description,
      glyph: extension.glyph,
      extensionElement: extension.elementTag,
      dataSeams: extension.dataSeams,
      desktop: extension.desktop === true,
    })),
  ];
}

export function xpeditionApp(
  id: XpeditionAppId,
): XpeditionApp | null {
  const core = XPEDITION_APPS.find((candidate) => candidate.id === id);
  if (core) return core;
  const extension = xpeditionExtension(id);
  return extension
    ? {
        id: extension.id,
        title: extension.title,
        shortTitle: extension.shortTitle,
        description: extension.description,
        glyph: extension.glyph,
        extensionElement: extension.elementTag,
        dataSeams: extension.dataSeams,
        desktop: extension.desktop === true,
      }
    : null;
}

export interface XpeditionWindowState {
  id: string;
  appId: XpeditionAppId;
  title: string;
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XpeditionDesktopState {
  activeWindowId: string | null;
  windows: XpeditionWindowState[];
}

export class XpeditionWindowManager {
  private windows: XpeditionWindowState[] = [];
  private activeWindowId: string | null = null;
  private nextZ = 10;

  constructor(private readonly onChange: (state: XpeditionDesktopState) => void = () => {}) {}

  get state(): XpeditionDesktopState {
    return {
      activeWindowId: this.activeWindowId,
      windows: this.windows.map((window) => ({ ...window })),
    };
  }

  open(appId: XpeditionAppId): XpeditionWindowState {
    const existing = this.windows.find((window) => window.appId === appId);
    if (existing) {
      existing.minimized = false;
      this.focus(existing.id);
      return { ...existing };
    }
    const app = xpeditionApp(appId);
    if (!app) throw new Error(`Unknown or unregistered XPedition app: ${appId}`);
    const offset = this.windows.length % 6;
    const window: XpeditionWindowState = {
      id: `xpedition-${appId}`,
      appId,
      title: app.title,
      minimized: false,
      maximized: false,
      zIndex: this.nextZ++,
      x: 108 + offset * 30,
      y: 42 + offset * 26,
      width: appId === 'chat' ? 920 : 820,
      height: appId === 'chat' ? 650 : 580,
    };
    this.windows.push(window);
    this.activeWindowId = window.id;
    this.changed();
    return { ...window };
  }

  focus(id: string): boolean {
    const window = this.windows.find((candidate) => candidate.id === id);
    if (!window) return false;
    window.minimized = false;
    window.zIndex = this.nextZ++;
    this.activeWindowId = id;
    this.compactZIndexes();
    this.changed();
    return true;
  }

  close(id: string): boolean {
    const index = this.windows.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.windows.splice(index, 1);
    if (this.activeWindowId === id) {
      const next = this.visibleWindows().sort((a, b) => b.zIndex - a.zIndex)[0];
      this.activeWindowId = next?.id ?? null;
    }
    this.changed();
    return true;
  }

  minimize(id: string): boolean {
    const window = this.windows.find((candidate) => candidate.id === id);
    if (!window) return false;
    window.minimized = true;
    if (this.activeWindowId === id) {
      const next = this.visibleWindows()
        .filter((candidate) => candidate.id !== id)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      this.activeWindowId = next?.id ?? null;
    }
    this.changed();
    return true;
  }

  toggleMaximize(id: string): boolean {
    const window = this.windows.find((candidate) => candidate.id === id);
    if (!window) return false;
    window.maximized = !window.maximized;
    this.focus(id);
    return true;
  }

  move(id: string, x: number, y: number): boolean {
    const window = this.windows.find((candidate) => candidate.id === id);
    if (!window || window.maximized) return false;
    window.x = Math.max(0, Math.round(x));
    window.y = Math.max(0, Math.round(y));
    this.changed();
    return true;
  }

  cycleFocus(reverse = false): string | null {
    const ordered = this.visibleWindows().sort((a, b) => b.zIndex - a.zIndex);
    if (ordered.length === 0) return null;
    const current = ordered.findIndex((window) => window.id === this.activeWindowId);
    const delta = reverse ? -1 : 1;
    const index = current < 0
      ? 0
      : (current + delta + ordered.length) % ordered.length;
    this.focus(ordered[index].id);
    return ordered[index].id;
  }

  private visibleWindows(): XpeditionWindowState[] {
    return this.windows.filter((window) => !window.minimized);
  }

  private compactZIndexes(): void {
    if (this.nextZ < 10_000) return;
    const ordered = [...this.windows].sort((a, b) => a.zIndex - b.zIndex);
    ordered.forEach((window, index) => {
      window.zIndex = 10 + index;
    });
    this.nextZ = 10 + ordered.length;
  }

  private changed(): void {
    this.onChange(this.state);
  }
}

export const RELEASE_RINGS = [
  'stable',
  'beta',
  'canary',
  'alpha',
  'nightly',
] as const;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];

export function isReleaseRing(value: unknown): value is ReleaseRing {
  return typeof value === 'string' &&
    (RELEASE_RINGS as readonly string[]).includes(value);
}

export interface ReleaseRingApplyResult {
  status: 'applied' | 'unavailable' | 'error';
  ring: ReleaseRing;
  message: string;
}

export interface ReleaseRingAdapter {
  current(): Promise<ReleaseRing>;
  available(): Promise<readonly ReleaseRing[]>;
  apply(ring: ReleaseRing): Promise<ReleaseRingApplyResult>;
}

export class FixtureReleaseRingAdapter implements ReleaseRingAdapter {
  async current(): Promise<ReleaseRing> {
    return 'stable';
  }

  async available(): Promise<readonly ReleaseRing[]> {
    return RELEASE_RINGS;
  }

  async apply(ring: ReleaseRing): Promise<ReleaseRingApplyResult> {
    if (!isReleaseRing(ring)) {
      return {
        status: 'error',
        ring: 'stable',
        message: 'The requested release ring is not supported.',
      };
    }
    if (ring === 'stable') {
      return {
        status: 'applied',
        ring,
        message: 'Stable is already the active release ring.',
      };
    }
    return {
      status: 'unavailable',
      ring,
      message:
        `The ${ring} preference was not applied because this build has no release-ring updater. ` +
        'No manifest was resolved and no files were changed.',
    };
  }
}

export type ShellPreference = 'xpedition' | 'legacy';
export type ContrastPreference = 'light' | 'dark' | 'high-contrast';

export interface XpeditionPreferences {
  version: 1;
  shell: ShellPreference;
  onboardingCompleted: boolean;
  releaseRing: ReleaseRing;
  contrast: ContrastPreference;
}

export const DEFAULT_XPEDITION_PREFERENCES: XpeditionPreferences = {
  version: 1,
  shell: 'xpedition',
  onboardingCompleted: false,
  releaseRing: 'stable',
  contrast: 'light',
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const fallbackStorageValues = new Map<string, string>();
const fallbackStorage: StorageLike = {
  getItem: (key) => fallbackStorageValues.get(key) ?? null,
  setItem: (key, value) => {
    fallbackStorageValues.set(key, value);
  },
};

export function xpeditionStorage(): StorageLike {
  try {
    return globalThis.window?.localStorage ?? fallbackStorage;
  } catch {
    return fallbackStorage;
  }
}

export const XPEDITION_PREFERENCES_KEY =
  'openrappter.xpedition.preferences.v1';
const LEGACY_SHELL_KEY = 'openrappter.shell';

export function loadXpeditionPreferences(
  storage: StorageLike,
): XpeditionPreferences {
  let candidate: unknown = null;
  try {
    const raw = storage.getItem(XPEDITION_PREFERENCES_KEY);
    if (raw) candidate = JSON.parse(raw);
  } catch {
    candidate = null;
  }
  const record = candidate && typeof candidate === 'object'
    ? candidate as Record<string, unknown>
    : {};
  const legacyShell = storage.getItem(LEGACY_SHELL_KEY);
  return {
    version: 1,
    shell: record.shell === 'legacy' || record.shell === 'xpedition'
      ? record.shell
      : legacyShell === 'legacy'
        ? 'legacy'
        : 'xpedition',
    onboardingCompleted: record.onboardingCompleted === true,
    releaseRing: isReleaseRing(record.releaseRing)
      ? record.releaseRing
      : 'stable',
    contrast: record.contrast === 'dark' ||
        record.contrast === 'high-contrast' ||
        record.contrast === 'light'
      ? record.contrast
      : 'light',
  };
}

export function saveXpeditionPreferences(
  storage: StorageLike,
  preferences: XpeditionPreferences,
): void {
  const safe: XpeditionPreferences = {
    version: 1,
    shell: preferences.shell === 'legacy' ? 'legacy' : 'xpedition',
    onboardingCompleted: preferences.onboardingCompleted === true,
    releaseRing: isReleaseRing(preferences.releaseRing)
      ? preferences.releaseRing
      : 'stable',
    contrast: preferences.contrast === 'dark' ||
        preferences.contrast === 'high-contrast'
      ? preferences.contrast
      : 'light',
  };
  storage.setItem(XPEDITION_PREFERENCES_KEY, JSON.stringify(safe));
  storage.setItem(LEGACY_SHELL_KEY, safe.shell);
}

export const ONBOARDING_STEPS = [
  'welcome',
  'privacy',
  'gateway',
  'release',
  'skills',
  'channels',
  'health',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' &&
    (ONBOARDING_STEPS as readonly string[]).includes(value);
}

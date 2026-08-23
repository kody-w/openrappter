import { XPEDITION_APP_IDS } from './xpedition.js';
import {
  APPROVAL_REQUIRED_ACTIONS,
  type ExternalAction,
} from './living-company.js';

interface DesktopElementSnapshot {
  ref: string;
  tag: string;
  text: string;
  ariaLabel: string;
  type: string;
  valueState: 'empty' | 'set';
  options: Array<{ label: string; value: string }>;
  selectedIndex: number | null;
  checked: boolean | null;
  disabled: boolean;
}

interface DesktopUiSnapshot {
  view: string;
  title: string;
  text: string;
  elements: DesktopElementSnapshot[];
}

interface XpeditionControllableApp extends HTMLElement {
  getDesktopState(): Record<string, unknown>;
  openDesktopApp(appId: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  focusDesktopWindow(id: string): Record<string, unknown>;
  closeDesktopWindow(id: string): Record<string, unknown>;
  selectOnboardingStep(step: string): Record<string, unknown>;
  switchShell(shell: 'xpedition' | 'legacy'): void;
  companyState(): Record<string, unknown>;
  runCompanyScenario(
    operation: 'start' | 'step' | 'run' | 'reset' | 'replay',
  ): Promise<Record<string, unknown>>;
  approveCompanyAction(
    requestId: string,
    action: ExternalAction,
    approved: boolean,
    humanConfirmed: boolean,
  ): Record<string, unknown>;
  updateComplete?: Promise<unknown>;
}

const views = new Set([
  'surgeon',
  'chat',
  'show-and-tell',
  'channels',
  'sessions',
  'cron',
  'config',
  'logs',
  'agents',
  'skills',
  'devices',
  'presence',
  'debug',
  'showcase',
  'zen',
  'accounts',
]);

const refs = new Map<string, HTMLElement>();
let snapshotGeneration = 0;
let currentGeneration = 0;
const sensitiveControl =
  /\b(?:password|passcode|token|secret|credential|authorization|api key|private key|cookie)\b/i;

function text(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? Array.from(value).slice(0, max).join('')
    : '';
}

function allElements(root: Document | ShadowRoot): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    found.push(element);
    if (element.shadowRoot) found.push(...allElements(element.shadowRoot));
  }
  return found;
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return false;
  }
  return element.getClientRects().length > 0 ||
    /jsdom/i.test(globalThis.navigator?.userAgent ?? '');
}

function crossesDesktopPrivateBoundary(element: HTMLElement): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.dataset.desktopPrivate !== undefined
    ) {
      return true;
    }
    const root = current.getRootNode();
    current = current.parentElement ??
      (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function interactiveElements(): HTMLElement[] {
  return allElements(document).filter((element) => {
    if (!isVisible(element) || crossesDesktopPrivateBoundary(element)) {
      return false;
    }
    if (element.matches('button, input, textarea, select, a[href]')) return true;
    return element.getAttribute('role') === 'button' ||
      element.getAttribute('contenteditable') === 'true';
  });
}

function isEditable(element: HTMLElement): boolean {
  return element.matches(
    'input, textarea, select, [contenteditable="true"]',
  );
}

function safePageText(): string {
  const roots: Array<Document | ShadowRoot> = [document];
  for (const element of allElements(document)) {
    if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
      roots.push(element.shadowRoot);
    }
  }
  const chunks: string[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (
        parent &&
        !crossesDesktopPrivateBoundary(parent) &&
        !parent.closest(
          'script, style, input, textarea, select, [contenteditable="true"], [data-desktop-private]',
        )
      ) {
        chunks.push(node.nodeValue ?? '');
      }
      node = walker.nextNode();
    }
  }
  return text(chunks.join(' ').replace(/\s+/g, ' ').trim(), 12_000);
}

function elementSnapshot(element: HTMLElement, ref: string): DesktopElementSnapshot {
  const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const label = element.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const editable = isEditable(element);
  const value = element.getAttribute('contenteditable') === 'true'
    ? element.textContent ?? ''
    : control.value ?? '';
  const options = element instanceof HTMLSelectElement
    ? Array.from(element.options).slice(0, 100).map((option) => ({
        label: text(option.label, 160),
        value: text(option.value, 160),
      }))
    : [];
  return {
    ref,
    tag: element.tagName.toLowerCase(),
    text: editable
      ? ''
      : text(element.innerText || element.textContent || '', 240).trim(),
    ariaLabel: text(element.getAttribute('aria-label') || label, 160),
    type: text((element as HTMLInputElement).type ?? '', 40),
    valueState: value.length > 0 ? 'set' : 'empty',
    options,
    selectedIndex: element instanceof HTMLSelectElement
      ? element.selectedIndex
      : null,
    checked: element instanceof HTMLInputElement &&
      (element.type === 'checkbox' || element.type === 'radio')
      ? element.checked
      : null,
    disabled: Boolean((element as HTMLButtonElement).disabled),
  };
}

export function snapshotDesktopUi(): DesktopUiSnapshot {
  refs.clear();
  currentGeneration = ++snapshotGeneration;
  const elements = interactiveElements().slice(0, 300).map((element, index) => {
    const ref = `g${currentGeneration}-ui-${index + 1}`;
    refs.set(ref, element);
    return elementSnapshot(element, ref);
  });
  const app = document.querySelector('openrappter-app') as
    | (HTMLElement & { currentView?: string })
    | null;
  return {
    view: app?.currentView ?? 'unknown',
    title: document.title,
    text: safePageText(),
    elements,
  };
}

async function navigate(view: unknown): Promise<Record<string, unknown>> {
  if (typeof view !== 'string' || !views.has(view)) {
    throw new Error(`Unknown OpenRappter view: ${String(view)}`);
  }
  const app = document.querySelector('openrappter-app') as
    | (HTMLElement & {
        navigate(view: string): void;
        updateComplete?: Promise<unknown>;
        navigationComplete?: Promise<unknown>;
      })
    | null;
  if (!app) throw new Error('OpenRappter app surface is not mounted.');
  app.navigate(view);
  await app.updateComplete;
  await app.navigationComplete;
  return { view };
}

function controllableApp(): XpeditionControllableApp {
  const app = document.querySelector('openrappter-app') as
    | XpeditionControllableApp
    | null;
  if (!app) throw new Error('OpenRappter app surface is not mounted.');
  return app;
}

function boundedString(
  value: unknown,
  name: string,
  allowed?: readonly string[],
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) {
    throw new Error(`${name} must be a non-empty bounded string.`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new Error(`Unknown ${name}: ${value}`);
  }
  return value;
}

function requireRef(value: unknown): HTMLElement {
  if (typeof value !== 'string') throw new Error('A UI ref is required.');
  if (!value.startsWith(`g${currentGeneration}-`)) {
    throw new Error('UI ref belongs to an older snapshot. Take a new snapshot.');
  }
  const element = refs.get(value);
  if (!element || !element.isConnected) {
    throw new Error('UI ref expired. Take a new snapshot and try again.');
  }
  return element;
}

function controlIsSensitive(element: HTMLElement): boolean {
  const label = element.closest('label')?.textContent ?? '';
  const metadata = [
    label,
    element.getAttribute('aria-label'),
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('placeholder'),
    element.getAttribute('autocomplete'),
  ].filter(Boolean).join(' ');
  return (
    (element instanceof HTMLInputElement && element.type === 'password') ||
    sensitiveControl.test(metadata) ||
    element.dataset.desktopSensitive !== undefined
  );
}

function setControlValue(element: HTMLElement, value: string): void {
  if (controlIsSensitive(element)) {
    throw new Error('Desktop automation cannot fill a sensitive control.');
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const prototype = element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: value,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }
  if (element instanceof HTMLSelectElement) {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }
  if (element.getAttribute('contenteditable') === 'true') {
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: value,
    }));
    return;
  }
  throw new Error('The selected UI element does not accept input.');
}

export async function handleDesktopUiCommand(
  command: { action?: unknown; args?: Record<string, unknown> },
): Promise<unknown> {
  const action = command.action;
  const args = command.args ?? {};
  switch (action) {
    case 'snapshot':
      return snapshotDesktopUi();
    case 'navigate':
      await navigate(args.view);
      return snapshotDesktopUi();
    case 'desktop_state':
      return controllableApp().getDesktopState();
    case 'open_app': {
      const appId = boundedString(
        args.appId,
        'XPedition app',
        XPEDITION_APP_IDS,
      );
      return await controllableApp().openDesktopApp(appId);
    }
    case 'focus_window':
      return controllableApp().focusDesktopWindow(
        boundedString(args.windowId, 'XPedition window id'),
      );
    case 'close_window':
      return controllableApp().closeDesktopWindow(
        boundedString(args.windowId, 'XPedition window id'),
      );
    case 'onboarding_step':
      return controllableApp().selectOnboardingStep(
        boundedString(args.step, 'onboarding step', [
          'welcome',
          'privacy',
          'gateway',
          'release',
          'skills',
          'channels',
          'health',
        ]),
      );
    case 'switch_shell': {
      const shell = boundedString(
        args.shell,
        'shell',
        ['xpedition', 'legacy'],
      ) as 'xpedition' | 'legacy';
      const app = controllableApp();
      app.switchShell(shell);
      await app.updateComplete;
      return app.getDesktopState();
    }
    case 'company_state':
      return controllableApp().companyState();
    case 'company_scenario': {
      const operation = boundedString(
        args.operation,
        'Living Company scenario operation',
        ['start', 'step', 'run', 'reset', 'replay'],
      ) as 'start' | 'step' | 'run' | 'reset' | 'replay';
      return await controllableApp().runCompanyScenario(operation);
    }
    case 'company_approve': {
      const action = boundedString(
        args.companyAction,
        'Living Company external action',
        APPROVAL_REQUIRED_ACTIONS,
      ) as ExternalAction;
      if (typeof args.approved !== 'boolean') {
        throw new Error('company_approve requires an explicit boolean approved decision.');
      }
      if (args.humanConfirmed !== true) {
        throw new Error('company_approve requires action-bound human confirmation.');
      }
      return controllableApp().approveCompanyAction(
        boundedString(args.requestId, 'company approval request id'),
        action,
        args.approved,
        true,
      );
    }
    case 'click': {
      const element = requireRef(args.ref);
      if (element.dataset.desktopSensitive !== undefined) {
        throw new Error('Desktop automation cannot activate this sensitive control.');
      }
      element.focus();
      element.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return snapshotDesktopUi();
    }
    case 'input':
    case 'select': {
      const element = requireRef(args.ref);
      setControlValue(element, text(args.value, 20_000));
      return elementSnapshot(element, String(args.ref));
    }
    case 'scroll': {
      const amount = Number.isFinite(args.amount)
        ? Math.max(1, Math.min(Number(args.amount), 4000))
        : 600;
      const direction = args.direction === 'up' ? -1 : 1;
      if (args.ref) {
        requireRef(args.ref).scrollIntoView({ block: direction < 0 ? 'start' : 'end' });
      } else {
        window.scrollBy({ top: direction * amount, behavior: 'smooth' });
      }
      return { direction: direction < 0 ? 'up' : 'down', amount };
    }
    case 'wait': {
      const milliseconds = Number.isFinite(args.milliseconds)
        ? Math.max(0, Math.min(Number(args.milliseconds), 5000))
        : 500;
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return snapshotDesktopUi();
    }
    default:
      throw new Error(`Unsupported desktop UI action: ${String(action)}`);
  }
}

export function installDesktopCommandHandler(): void {
  (window as unknown as {
    __openrappterDesktopCommand?: typeof handleDesktopUiCommand;
  }).__openrappterDesktopCommand = handleDesktopUiCommand;
}

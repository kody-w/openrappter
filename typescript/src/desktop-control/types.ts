export const DESKTOP_COMMAND_SCHEMA = 'openrappter-desktop-command/1.0' as const;
export const DESKTOP_RESULT_SCHEMA = 'openrappter-desktop-result/1.0' as const;

export type DesktopControlAction =
  | 'snapshot'
  | 'navigate'
  | 'click'
  | 'input'
  | 'select'
  | 'scroll'
  | 'wait'
  | 'desktop_state'
  | 'open_app'
  | 'focus_window'
  | 'close_window'
  | 'onboarding_step'
  | 'switch_shell'
  | 'company_state'
  | 'company_scenario'
  | 'company_approve'
  | 'install_agent';

export interface DesktopCommand {
  schema: typeof DESKTOP_COMMAND_SCHEMA;
  id: string;
  action: DesktopControlAction;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export interface DesktopCommandResult {
  schema: typeof DESKTOP_RESULT_SCHEMA;
  id: string;
  status: 'success' | 'error';
  result?: unknown;
  error?: string;
  completedAt: number;
}

export interface DesktopElementSnapshot {
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

export interface DesktopUiSnapshot {
  view: string;
  title: string;
  text: string;
  elements: DesktopElementSnapshot[];
}

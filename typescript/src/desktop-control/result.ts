import {
  DesktopCommandQueue,
} from './queue.js';
import type { DesktopControlAction } from './types.js';

const permitted = new Set<DesktopControlAction>([
  'snapshot',
  'navigate',
  'click',
  'input',
  'select',
  'scroll',
  'wait',
  'desktop_state',
  'open_app',
  'focus_window',
  'close_window',
  'onboarding_step',
  'switch_shell',
]);

let sharedQueue: DesktopCommandQueue | undefined;

function queue(): DesktopCommandQueue {
  sharedQueue ??= new DesktopCommandQueue();
  return sharedQueue;
}

export async function dispatchAgentUiCommands(result: string): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result) as Record<string, unknown>;
  } catch {
    return result;
  }
  if (parsed.status === 'error' || !Array.isArray(parsed.ui_commands)) {
    return result;
  }
  const commands = parsed.ui_commands.slice(0, 10);
  const outcomes: Array<Record<string, unknown>> = [];
  for (const candidate of commands) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      outcomes.push({ status: 'error', error: 'Invalid UI command.' });
      continue;
    }
    const command = candidate as Record<string, unknown>;
    const action = command.action;
    if (typeof action !== 'string' || !permitted.has(action as DesktopControlAction)) {
      outcomes.push({
        status: 'error',
        error: `Unsupported agent UI action: ${String(action)}`,
      });
      continue;
    }
    const args: Record<string, unknown> = {
      ...command,
      action: undefined,
    };
    delete args.action;
    try {
      const waitMs =
        action === 'wait' && Number.isFinite(args.milliseconds)
          ? Math.max(0, Math.min(Number(args.milliseconds), 5_000))
          : 0;
      const response = await queue().execute(
        action as DesktopControlAction,
        args,
        Math.max(5_000, waitMs + 2_000),
      );
      outcomes.push(
        response.status === 'success'
          ? { status: 'success', result: response.result }
          : { status: 'error', error: response.error },
      );
    } catch (error) {
      outcomes.push({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  parsed.ui_results = outcomes;
  const failures = outcomes.filter((outcome) => outcome.status === 'error');
  if (failures.length > 0) {
    parsed.status = 'error';
    parsed.error = 'One or more requested desktop UI commands failed.';
  }
  return JSON.stringify(parsed);
}

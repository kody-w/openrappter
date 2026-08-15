import { safeComputerActionData } from './privacy.js';
import { ShowAndTellStore, showAndTellRoot } from './store.js';

export async function recordActiveComputerAction(
  action: string,
  kwargs: Record<string, unknown>,
  result?: Record<string, unknown>,
): Promise<void> {
  const store = new ShowAndTellStore(showAndTellRoot());
  try {
    await store.initialize();
    const active = await store.activeSession();
    if (!active || active.state !== 'recording') return;
    await store.appendEvent(
      active.id,
      'computer.action',
      'computer-use',
      safeComputerActionData(action, kwargs, result),
    );
  } catch {
    // Demonstration recording must never break a ComputerUse action.
  } finally {
    store.close();
  }
}

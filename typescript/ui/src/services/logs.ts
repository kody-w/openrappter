/**
 * Logs controller — load and filter log entries.
 */
import type { GatewayClient, EventCallback } from './gateway.js';
import type { LogEntry } from '../types.js';

export interface LogsState {
  client: GatewayClient | null;
  logs: LogEntry[];
  levelFilter: Set<string>;
  maxEntries: number;
  error: string | null;
}

export function createLogsState(): LogsState {
  return {
    client: null,
    logs: [],
    levelFilter: new Set(['debug', 'info', 'warn', 'error']),
    maxEntries: 1000,
    error: null,
  };
}

export function addLogEntry(state: LogsState, entry: LogEntry): void {
  state.logs = [...state.logs, entry].slice(-state.maxEntries);
}

export function clearLogs(state: LogsState): void {
  state.logs = [];
}

export function toggleLevel(state: LogsState, level: string): void {
  if (state.levelFilter.has(level)) {
    state.levelFilter.delete(level);
  } else {
    state.levelFilter.add(level);
  }
}

export function getFilteredLogs(state: LogsState): LogEntry[] {
  return state.logs.filter((l) => state.levelFilter.has(l.level));
}

export function subscribeToLogs(state: LogsState): EventCallback {
  const handler: EventCallback = (data) => {
    addLogEntry(state, data as LogEntry);
  };
  state.client?.on('log', handler);
  return handler;
}

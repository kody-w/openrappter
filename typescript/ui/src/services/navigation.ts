export const VIEW_IDS = [
  'work', 'surgeon', 'rappids', 'chat', 'show-and-tell', 'channels',
  'sessions', 'cron', 'config', 'logs', 'agents', 'skills', 'devices',
  'presence', 'debug', 'showcase', 'zen', 'accounts',
] as const;

export type View = typeof VIEW_IDS[number];

export function isView(value: unknown): value is View {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value);
}

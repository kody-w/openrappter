// Optional dependency — install with: npm install @whiskeysockets/baileys
declare module '@whiskeysockets/baileys' {
  export default function makeWASocket(opts: Record<string, unknown>): unknown;
  export function useMultiFileAuthState(path: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  export function fetchLatestBaileysVersion(): Promise<{ version: number[] }>;
  export const DisconnectReason: { loggedOut: number };
}

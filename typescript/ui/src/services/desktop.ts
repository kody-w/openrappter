export interface DesktopShowAndTellRequest {
  action: string;
  [key: string]: unknown;
}

export interface OpenRappterDesktopBridge {
  platform: string;
  gatewayUrl: string;
  gatewayToken: string;
  showAndTell(request: DesktopShowAndTellRequest): Promise<Record<string, unknown>>;
  desktopControl(request: DesktopShowAndTellRequest): Promise<Record<string, unknown>>;
  narration(request: DesktopShowAndTellRequest): Promise<Record<string, unknown>>;
  onNarrationStatus(
    callback: (status: Record<string, unknown>) => void,
  ): () => void;
  voice(request: DesktopShowAndTellRequest): Promise<Record<string, unknown>>;
  openGithubDeviceLogin(): Promise<{ opened: boolean }>;
  patientChat(request:
    | { action: 'probe' }
    | { action: 'send'; userInput: string; sessionId?: string }
    | { action: 'cancel' }
  ): Promise<{
    status: number;
    body: string;
    error?: 'offline' | 'timeout' | 'server-error';
  }>;
  onVoiceStatus(
    callback: (status: Record<string, unknown>) => void,
  ): () => void;
  getInfo(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    openrappterDesktop?: OpenRappterDesktopBridge;
  }
}

export function desktopBridge(): OpenRappterDesktopBridge | null {
  return window.openrappterDesktop ?? null;
}

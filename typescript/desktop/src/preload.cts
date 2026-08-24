import { contextBridge, ipcRenderer } from 'electron';

interface DesktopShowAndTellRequest {
  action: string;
  [key: string]: unknown;
}

contextBridge.exposeInMainWorld('openrappterDesktop', {
  platform: process.platform,
  gatewayUrl: `ws://127.0.0.1:${process.env.OPENRAPPTER_PORT ?? '18790'}`,
  gatewayToken: process.env.OPENRAPPTER_TOKEN ?? '',
  showAndTell: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:show-and-tell', request),
  desktopControl: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:desktop-control', request),
  narration: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:narration', request),
  onNarrationStatus: (
    callback: (status: Record<string, unknown>) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: Record<string, unknown>,
    ) => callback(status);
    ipcRenderer.on('openrappter:narration-status', listener);
    return () => ipcRenderer.removeListener(
      'openrappter:narration-status',
      listener,
    );
  },
  voice: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:voice', request),
  openGithubDeviceLogin: () =>
    ipcRenderer.invoke('openrappter:github-device-login'),
  patientChat: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:patient-chat', request),
  onVoiceStatus: (
    callback: (status: Record<string, unknown>) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: Record<string, unknown>,
    ) => callback(status);
    ipcRenderer.on('openrappter:voice-status', listener);
    return () => ipcRenderer.removeListener(
      'openrappter:voice-status',
      listener,
    );
  },
  getInfo: () => ipcRenderer.invoke('openrappter:desktop-info'),
});

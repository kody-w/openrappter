import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  buddyEvidence: (request: DesktopShowAndTellRequest) =>
    ipcRenderer.invoke('openrappter:buddy-evidence', request),
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
  mediaStart: (
    file: File,
    request: Record<string, unknown>,
  ) => {
    // Electron deliberately removed File.path. webUtils accepts only a real
    // renderer File object, so no renderer-supplied string becomes a path.
    const sourcePath = webUtils.getPathForFile(file);
    if (!sourcePath) throw new Error('Selected file has no safe local path handoff.');
    return ipcRenderer.invoke('openrappter:media-start', {
      ...request,
      sourcePath,
    });
  },
  mediaStatus: (uploadId: string) =>
    ipcRenderer.invoke('openrappter:media-status', { uploadId }),
  mediaCancel: (uploadId: string) =>
    ipcRenderer.invoke('openrappter:media-cancel', { uploadId }),
  onMediaStatus: (
    callback: (status: Record<string, unknown>) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: Record<string, unknown>,
    ) => callback(status);
    ipcRenderer.on('openrappter:media-status', listener);
    return () => ipcRenderer.removeListener(
      'openrappter:media-status',
      listener,
    );
  },
  getInfo: () => ipcRenderer.invoke('openrappter:desktop-info'),
});

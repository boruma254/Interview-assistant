import { contextBridge, ipcRenderer } from 'electron';
import type { ChatEvent, ChatRequest, GuardDiagnostics, PrivacyStatus, SettingsInput, SettingsSnapshot } from '../shared/contracts';

contextBridge.exposeInMainWorld('desktop', {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<SettingsSnapshot>,
  saveSettings: (settings: SettingsInput) => ipcRenderer.invoke('settings:save', settings) as Promise<SettingsSnapshot>,
  streamChat: (request: ChatRequest, onEvent: (event: ChatEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: ChatEvent) => {
      if (message.requestId === request.requestId) onEvent(message);
    };
    ipcRenderer.on('ai:chunk', listener);
    void ipcRenderer.invoke('ai:stream', request).catch(error => {
      onEvent({ requestId: request.requestId, done: true, error: error instanceof Error ? error.message : 'The request could not be started.' });
    }).finally(() => ipcRenderer.removeListener('ai:chunk', listener));
    return () => {
      ipcRenderer.removeListener('ai:chunk', listener);
      void ipcRenderer.invoke('ai:cancel', request.requestId);
    };
  },
  transcribe: (audioBase64: string, mimeType: string, requestId: string) =>
    ipcRenderer.invoke('voice:transcribe', { audioBase64, mimeType, requestId }) as Promise<string>,
  minimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  setWindowMode: (mode: 'toolbar' | 'expanded' | 'answer') => ipcRenderer.invoke('window:set-mode', mode) as Promise<void>,
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:set-always-on-top', value) as Promise<boolean>,
  openOverlayLab: () => ipcRenderer.invoke('lab:open') as Promise<void>,
  getPrivacyStatus: () => ipcRenderer.invoke('privacy:get-status') as Promise<PrivacyStatus>,
  enablePrivacyMode: () => ipcRenderer.invoke('privacy:enable') as Promise<PrivacyStatus>,
  disablePrivacyMode: () => ipcRenderer.invoke('privacy:disable') as Promise<boolean>,
  hidePrivacyPrompt: () => ipcRenderer.invoke('privacy:hide-prompt') as Promise<void>,
  onPrivacyStateChanged: (callback: (status: PrivacyStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: PrivacyStatus) => callback(status);
    ipcRenderer.on('privacy:changed', listener);
    return () => ipcRenderer.removeListener('privacy:changed', listener);
  },
  getGuardDiagnostics: () => ipcRenderer.invoke('guard:get-diagnostics') as Promise<GuardDiagnostics>,
  confirmGuardSession: () => ipcRenderer.invoke('guard:confirm-session', true) as Promise<boolean>,
  revokeGuardSession: () => ipcRenderer.invoke('guard:revoke-session') as Promise<boolean>,
  onGuardConsentChanged: (callback: (confirmed: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, confirmed: boolean) => callback(confirmed);
    ipcRenderer.on('guard:consent-changed', listener);
    return () => ipcRenderer.removeListener('guard:consent-changed', listener);
  },
  close: () => ipcRenderer.invoke('window:close') as Promise<void>,
});

contextBridge.exposeInMainWorld('privacyControls', {
  enterShareSafeMode: () =>
    (ipcRenderer.invoke('privacy:enable') as Promise<PrivacyStatus>).then(status => status.active),
  exitShareSafeMode: () => ipcRenderer.invoke('privacy:disable') as Promise<boolean>,
  onModeChanged: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled);
    ipcRenderer.on('privacy:share-safe-mode', listener);
    return () => ipcRenderer.removeListener('privacy:share-safe-mode', listener);
  },
});

import { contextBridge, ipcRenderer } from 'electron';
import type { ChatEvent, ChatRequest, SettingsInput, SettingsSnapshot } from '../shared/contracts';

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
  transcribe: (audioBase64: string, mimeType: string) =>
    ipcRenderer.invoke('voice:transcribe', { audioBase64, mimeType }) as Promise<string>,
  minimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  setWindowMode: (mode: 'toolbar' | 'expanded') => ipcRenderer.invoke('window:set-mode', mode) as Promise<void>,
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:set-always-on-top', value) as Promise<boolean>,
  close: () => ipcRenderer.invoke('window:close') as Promise<void>,
});

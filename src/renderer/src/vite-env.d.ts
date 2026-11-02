/// <reference types="vite/client" />

import type { ChatEvent, ChatRequest, SettingsInput, SettingsSnapshot } from '../../shared/contracts';

type DesktopBridge = {
  getSettings: () => Promise<SettingsSnapshot>;
  saveSettings: (settings: SettingsInput) => Promise<SettingsSnapshot>;
  streamChat: (request: ChatRequest, onEvent: (event: ChatEvent) => void) => () => void;
  transcribe: (audioBase64: string, mimeType: string) => Promise<string>;
  minimize: () => Promise<void>;
  setWindowMode: (mode: 'toolbar' | 'expanded') => Promise<void>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  close: () => Promise<void>;
};

declare global {
  interface Window { desktop: DesktopBridge }
}

export {};

/// <reference types="vite/client" />

import type { ChatEvent, ChatRequest, GuardDiagnostics, PrivacyStatus, SettingsInput, SettingsSnapshot } from '../../shared/contracts';

type DesktopBridge = {
  getSettings: () => Promise<SettingsSnapshot>;
  saveSettings: (settings: SettingsInput) => Promise<SettingsSnapshot>;
  streamChat: (request: ChatRequest, onEvent: (event: ChatEvent) => void) => () => void;
  transcribe: (audioBase64: string, mimeType: string, requestId: string) => Promise<string>;
  minimize: () => Promise<void>;
  setWindowMode: (mode: 'toolbar' | 'expanded' | 'answer') => Promise<void>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  openOverlayLab: () => Promise<void>;
  getPrivacyStatus: () => Promise<PrivacyStatus>;
  enablePrivacyMode: () => Promise<PrivacyStatus>;
  disablePrivacyMode: () => Promise<boolean>;
  hidePrivacyPrompt: () => Promise<void>;
  onPrivacyStateChanged: (callback: (status: PrivacyStatus) => void) => () => void;
  getGuardDiagnostics: () => Promise<GuardDiagnostics>;
  confirmGuardSession: () => Promise<boolean>;
  revokeGuardSession: () => Promise<boolean>;
  onGuardConsentChanged: (callback: (confirmed: boolean) => void) => () => void;
  close: () => Promise<void>;
};

type PrivacyControls = {
  enterShareSafeMode: () => Promise<boolean>;
  exitShareSafeMode: () => Promise<boolean>;
  onModeChanged: (callback: (enabled: boolean) => void) => () => void;
};

declare global {
  interface Window {
    desktop: DesktopBridge
    privacyControls: PrivacyControls
  }
}

export {};

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

export type AppSettings = {
  aiProvider: 'openai';
  model: string;
  apiEndpoint: string;
  speechProvider: 'openai';
  responseStyle: 'concise' | 'balanced' | 'detailed';
  maxResponseLength: number;
  historyLimit: number;
  theme: 'dark' | 'light';
  fontSize: number;
  alwaysOnTop: boolean;
  keyboardShortcut: string;
  microphoneId: string;
  guard: GuardPolicySettings;
};

export type GuardPolicySettings = {
  restrictedMode: boolean;
  allowMicrophoneRecording: boolean;
  allowTranscription: boolean;
  allowAiAssistance: boolean;
};

export type GuardPermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'unsupported'
  | 'not-applicable';

export type GuardPermissionCheck = {
  state: GuardPermissionState;
  detail: string;
};

export type GuardDiagnostics = {
  checkedAt: string;
  platform: 'macos' | 'windows' | 'unsupported';
  sessionConsent: boolean;
  window: {
    visible: boolean | null;
    alwaysOnTop: boolean | null;
  };
  display: {
    screenRecordingPermission: GuardPermissionCheck;
    captureActivity: {
      state: 'unknown';
      detail: string;
    };
  };
  audio: {
    microphonePermission: GuardPermissionCheck;
    systemAudioCapture: GuardPermissionCheck;
  };
  device: {
    restrictions: {
      state: 'restriction-reported' | 'unknown';
      detail: string;
    };
  };
};

export type SettingsSnapshot = {
  settings: AppSettings;
  hasApiKey: boolean;
};

export type PrivacyStatus = {
  active: boolean;
  alwaysOnTop: boolean;
};

export type SettingsInput = {
  settings: AppSettings;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type ChatRequest = {
  requestId: string;
  messages: ChatMessage[];
  settings: AppSettings;
};

export type ChatEvent = {
  requestId: string;
  delta?: string;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
};

export type TranscriptRequest = {
  requestId: string;
  audioBase64: string;
  mimeType: string;
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

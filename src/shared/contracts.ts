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
};

export type SettingsSnapshot = {
  settings: AppSettings;
  hasApiKey: boolean;
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
  audioBase64: string;
  mimeType: string;
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

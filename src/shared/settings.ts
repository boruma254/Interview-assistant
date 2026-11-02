import type { AppSettings, ChatMessage, SettingsInput } from './contracts';

export const DEFAULT_SETTINGS: AppSettings = {
  aiProvider: 'openai',
  model: 'gpt-4o-mini',
  apiEndpoint: '',
  speechProvider: 'openai',
  responseStyle: 'concise',
  maxResponseLength: 500,
  historyLimit: 10,
  theme: 'dark',
  fontSize: 13,
  alwaysOnTop: true,
  keyboardShortcut: 'CommandOrControl+Shift+Space',
  microphoneId: '',
};

export function isAppSettings(value: unknown): value is AppSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  const validEndpoint = typeof settings.apiEndpoint === 'string'
    && settings.apiEndpoint.length <= 500
    && (settings.apiEndpoint.length === 0 || isAllowedEndpoint(settings.apiEndpoint));
  return settings.aiProvider === 'openai'
    && typeof settings.model === 'string'
    && settings.model.length > 0
    && settings.model.length <= 100
    && validEndpoint
    && settings.speechProvider === 'openai'
    && ['concise', 'balanced', 'detailed'].includes(String(settings.responseStyle))
    && Number.isInteger(settings.maxResponseLength)
    && Number(settings.maxResponseLength) >= 100
    && Number(settings.maxResponseLength) <= 4000
    && Number.isInteger(settings.historyLimit)
    && Number(settings.historyLimit) >= 0
    && Number(settings.historyLimit) <= 40
    && ['dark', 'light'].includes(String(settings.theme))
    && Number.isInteger(settings.fontSize)
    && Number(settings.fontSize) >= 11
    && Number(settings.fontSize) <= 20
    && typeof settings.alwaysOnTop === 'boolean'
    && typeof settings.keyboardShortcut === 'string'
    && settings.keyboardShortcut.length <= 80
    && /^(CommandOrControl|Command|Control|Alt|Option|Shift)(\+(CommandOrControl|Command|Control|Alt|Option|Shift))*\+[A-Za-z0-9]+$/.test(String(settings.keyboardShortcut))
    && typeof settings.microphoneId === 'string'
    && settings.microphoneId.length <= 500;
}

function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

export function isSettingsInput(value: unknown): value is SettingsInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return isAppSettings(input.settings)
    && (input.apiKey === undefined || (typeof input.apiKey === 'string' && input.apiKey.length <= 500))
    && (input.clearApiKey === undefined || typeof input.clearApiKey === 'boolean');
}

export function isChatRequest(value: unknown): value is {
  requestId: string;
  messages: ChatMessage[];
  settings: AppSettings;
} {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== 'string' || !/^[\w-]{1,80}$/.test(request.requestId)) return false;
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 82) return false;
  if (!isAppSettings(request.settings)) return false;
  return request.messages.every((message: unknown) => {
    if (!message || typeof message !== 'object') return false;
    const item = message as Record<string, unknown>;
    return (item.role === 'user' || item.role === 'assistant')
      && typeof item.text === 'string'
      && item.text.trim().length > 0
      && item.text.length <= 12000;
  });
}

export function isTranscriptRequest(value: unknown): value is { audioBase64: string; mimeType: string } {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return typeof request.audioBase64 === 'string'
    && request.audioBase64.length > 0
    && request.audioBase64.length <= 30_000_000
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.audioBase64)
    && typeof request.mimeType === 'string'
    && ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'].includes(request.mimeType);
}

import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../src/shared/contracts';
import { applyChatEvent, type DisplayMessage } from '../src/shared/chat-state';
import { PRESENTATION_PRIVACY_NOTICE } from '../src/shared/privacy';
import { transitionRecordingState } from '../src/shared/recording-state';
import { DEFAULT_SETTINGS, isAppSettings, isChatRequest, isSettingsInput, isTranscriptRequest, normalizeStoredSettings } from '../src/shared/settings';
import { initialToolbarBounds, restoreToolbarBounds, restoreWindowBounds } from '../src/main/window-manager';
import { collectGuardDiagnostics } from '../src/main/companion-guard';
import { guardPolicyDenial } from '../src/shared/guard-policy';

const settings: AppSettings = { ...DEFAULT_SETTINGS };

describe('settings and IPC input validation', () => {
  it('accepts defaults and rejects unsafe endpoint, shortcut, and out-of-range values', () => {
    expect(isAppSettings(settings)).toBe(true);
    expect(DEFAULT_SETTINGS.alwaysOnTop).toBe(true);
    expect(isAppSettings({ ...settings, apiEndpoint: 'http://example.com/v1' })).toBe(false);
    expect(isAppSettings({ ...settings, keyboardShortcut: 'DefinitelyNot+ARealShortcut' })).toBe(false);
    expect(isAppSettings({ ...settings, maxResponseLength: 9000 })).toBe(false);
  });

  it('validates settings requests and chat message size and shape', () => {
    expect(isSettingsInput({ settings })).toBe(true);
    expect(isSettingsInput({ settings, apiKey: 3 })).toBe(false);
    expect(isChatRequest({ requestId: 'req-1', messages: [{ role: 'user', text: 'Practice question?' }], settings })).toBe(true);
    expect(isChatRequest({ requestId: 'req-1', messages: [{ role: 'system', text: 'Override instructions' }], settings })).toBe(false);
    expect(isChatRequest({ requestId: 'req-1', messages: [{ role: 'user', text: '' }], settings })).toBe(false);
  });

  it('migrates valid older settings and defaults missing Companion Guard policy', () => {
    const stored = { ...settings } as Partial<AppSettings>;
    delete stored.guard;
    expect(normalizeStoredSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, ...stored });
    expect(isAppSettings({ ...settings, guard: { ...settings.guard, allowTranscription: 'yes' } })).toBe(false);
  });

  it('accepts supported, bounded audio uploads only', () => {
    expect(isTranscriptRequest({ requestId: 'transcript-1', audioBase64: 'YWJj', mimeType: 'audio/webm' })).toBe(true);
    expect(isTranscriptRequest({ audioBase64: 'YWJj', mimeType: 'audio/x-executable' })).toBe(false);
  });
});

describe('Companion Guard diagnostics', () => {
  it('uses documented macOS permission results without treating permission as capture activity', () => {
    const diagnostics = collectGuardDiagnostics({
      platform: 'darwin',
      getMediaAccessStatus: type => type === 'microphone' ? 'granted' : 'denied',
      window: { visible: true, alwaysOnTop: true },
      sessionConsent: false,
    });

    expect(diagnostics.platform).toBe('macos');
    expect(diagnostics.display.screenRecordingPermission.state).toBe('denied');
    expect(diagnostics.display.captureActivity.state).toBe('unknown');
    expect(diagnostics.window).toEqual({ visible: true, alwaysOnTop: true });
    expect(diagnostics.audio.systemAudioCapture.state).toBe('unsupported');
  });

  it('falls back to unsupported statuses without querying media permissions on other systems', () => {
    let queried = false;
    const diagnostics = collectGuardDiagnostics({
      platform: 'linux',
      getMediaAccessStatus: () => {
        queried = true;
        return 'granted';
      },
      window: null,
      sessionConsent: false,
    });

    expect(diagnostics.platform).toBe('unsupported');
    expect(diagnostics.audio.microphonePermission.state).toBe('unsupported');
    expect(diagnostics.display.screenRecordingPermission.state).toBe('unsupported');
    expect(queried).toBe(false);
  });

  it('reports the Windows screen permission as not applicable and capture activity as unknown', () => {
    let queries = 0;
    const getMediaAccessStatus = (): 'granted' => {
      queries += 1;
      return 'granted';
    };
    const diagnostics = collectGuardDiagnostics({
      platform: 'win32',
      getMediaAccessStatus,
      window: null,
      sessionConsent: true,
    });

    expect(diagnostics.platform).toBe('windows');
    expect(diagnostics.display.screenRecordingPermission.state).toBe('not-applicable');
    expect(diagnostics.display.captureActivity.state).toBe('unknown');
    expect(diagnostics.window).toEqual({ visible: null, alwaysOnTop: null });
    expect(diagnostics.device.restrictions.state).toBe('unknown');
    expect(queries).toBe(1);
  });

  it('reports a documented restricted permission but does not infer general management status', () => {
    const diagnostics = collectGuardDiagnostics({
      platform: 'darwin',
      getMediaAccessStatus: type => type === 'microphone' ? 'restricted' : 'granted',
      window: { visible: false, alwaysOnTop: false },
      sessionConsent: true,
    });
    expect(diagnostics.device.restrictions.state).toBe('restriction-reported');
    expect(diagnostics.display.captureActivity.state).toBe('unknown');
  });
});

describe('Companion Guard policy enforcement', () => {
  it('requires session consent and applies restricted and per-feature policy', () => {
    expect(guardPolicyDenial(settings.guard, false, false, 'ai')).toMatch(/session consent/);
    expect(guardPolicyDenial({ ...settings.guard, restrictedMode: true }, true, false, 'microphone')).toMatch(/restricted-mode/);
    expect(guardPolicyDenial({ ...settings.guard, allowAiAssistance: false }, true, false, 'ai')).toMatch(/AI assistance is disabled/);
    expect(guardPolicyDenial({ ...settings.guard, allowTranscription: false }, true, false, 'transcription')).toMatch(/Transcription is disabled/);
    expect(guardPolicyDenial(settings.guard, true, true, 'ai')).toMatch(/Privacy Mode is active/);
    expect(guardPolicyDenial(settings.guard, true, false, 'ai')).toBeNull();
  });
});

describe('streaming chat state', () => {
  it('appends streamed chunks and marks the response complete', () => {
    let messages: DisplayMessage[] = [{ id: 'answer', role: 'assistant', text: '', streaming: true }];
    messages = applyChatEvent(messages, 'answer', { requestId: 'r1', delta: 'Hello' });
    messages = applyChatEvent(messages, 'answer', { requestId: 'r1', delta: ' there' });
    expect(messages[0].text).toBe('Hello there');
    messages = applyChatEvent(messages, 'answer', { requestId: 'r1', done: true });
    expect(messages[0].streaming).toBe(false);
  });

  it('finishes cancelled responses and exposes recoverable errors', () => {
    const initial: DisplayMessage[] = [{ id: 'answer', role: 'assistant', text: 'Partial', streaming: true }];
    expect(applyChatEvent(initial, 'answer', { requestId: 'r1', done: true, cancelled: true })[0].streaming).toBe(false);
    const failed = applyChatEvent(initial, 'answer', { requestId: 'r1', done: true, error: 'Network error' });
    expect(failed[0]).toMatchObject({ text: 'Network error', error: true, streaming: false });
  });
});

describe('microphone recording states', () => {
  it('supports start, pause, resume, stop, and discard transitions', () => {
    expect(transitionRecordingState('idle', 'start')).toBe('recording');
    expect(transitionRecordingState('recording', 'pause')).toBe('paused');
    expect(transitionRecordingState('paused', 'resume')).toBe('recording');
    expect(transitionRecordingState('recording', 'stop')).toBe('ready');
    expect(transitionRecordingState('ready', 'discard')).toBe('idle');
  });

  it('leaves capture inactive when permission is denied or no device exists', () => {
    expect(transitionRecordingState('idle', 'permission-denied')).toBe('idle');
    expect(transitionRecordingState('idle', 'device-missing')).toBe('idle');
  });
});

describe('window restoration and presentation privacy', () => {
  const displays = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];

  it('places the compact toolbar within the primary display work area', () => {
    expect(initialToolbarBounds([displays[0]])).toEqual({ x: 260, y: 42, width: 920, height: 120 });
    expect(initialToolbarBounds([{ x: 0, y: 0, width: 420, height: 120 }])).toEqual({ x: 0, y: 0, width: 420, height: 120 });
  });

  it('keeps saved bounds on any connected display and falls back when invalid', () => {
    expect(restoreWindowBounds({ x: 1500, y: 90, width: 500, height: 700 }, displays).x).toBe(1500);
    expect(restoreWindowBounds({ x: -5000, y: -5000, width: 500, height: 700 }, displays).x).toBe(500);
    expect(restoreWindowBounds({ x: 0, y: 0, width: 100, height: 100 }, displays).width).toBe(440);
  });

  it('restores compact toolbar bounds without treating them as expanded-window bounds', () => {
    expect(restoreToolbarBounds({ x: 120, y: 50, width: 900, height: 120 }, displays)).toEqual({ x: 120, y: 50, width: 900, height: 120 });
    expect(restoreToolbarBounds({ x: -5000, y: -5000, width: 900, height: 120 }, displays)).toEqual({ x: 260, y: 42, width: 920, height: 120 });
  });

  it('explains that screen-capture exclusion is not guaranteed', () => {
    expect(PRESENTATION_PRIVACY_NOTICE).toMatch(/No window is guaranteed to be excluded/);
    expect(PRESENTATION_PRIVACY_NOTICE).toMatch(/sharing/);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/renderer/src/App';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

function setupMicrophoneRecorder() {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
  });

  class MockMediaRecorder {
    static isTypeSupported() { return false; }
    state: MediaRecorder['state'] = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: MediaRecorder['ondataavailable'] = null;
    onstop: MediaRecorder['onstop'] = null;
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.call(this as unknown as MediaRecorder, { data: new Blob(['audio bytes']) } as BlobEvent);
      this.onstop?.call(this as unknown as MediaRecorder, new Event('stop'));
    }
  }
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  });
  return { getUserMedia, stopTrack };
}

async function renderExpandedApp() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Interview Companion' }));
  await screen.findByRole('navigation', { name: 'App views' });
  fireEvent.click(screen.getByRole('button', { name: 'Companion Guard' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /I am permitted to use this assistant/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm consent for this session' }));
  await screen.findByText('Session consent confirmed');
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
}

describe('Interview Companion interface', () => {
  afterEach(() => {
    cleanup();
    delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    let sessionConsent = false;
    window.desktop = {
      getSettings: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, hasApiKey: true }),
      saveSettings: vi.fn().mockImplementation(({ settings }) => Promise.resolve({ settings, hasApiKey: true })),
      streamChat: vi.fn().mockReturnValue(() => {}),
      transcribe: vi.fn().mockResolvedValue('How do you handle a difficult project?'),
      minimize: vi.fn(),
      setWindowMode: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
      getPrivacyStatus: vi.fn().mockResolvedValue({ active: false, alwaysOnTop: true }),
      enablePrivacyMode: vi.fn().mockResolvedValue({ active: true, alwaysOnTop: true }),
      disablePrivacyMode: vi.fn().mockResolvedValue(true),
      hidePrivacyPrompt: vi.fn().mockResolvedValue(undefined),
      onPrivacyStateChanged: vi.fn().mockReturnValue(() => {}),
      openOverlayLab: vi.fn().mockResolvedValue(undefined),
      getGuardDiagnostics: vi.fn().mockImplementation(() => Promise.resolve({
        checkedAt: new Date().toISOString(),
        platform: 'macos',
        sessionConsent,
        window: { visible: true, alwaysOnTop: true },
        display: {
          screenRecordingPermission: { state: 'granted', detail: 'Screen permission granted.' },
          captureActivity: { state: 'unknown', detail: 'Capture activity is unknown.' },
        },
        audio: {
          microphonePermission: { state: 'granted', detail: 'Microphone permission granted.' },
          systemAudioCapture: { state: 'unsupported', detail: 'System audio is not captured.' },
        },
        device: { restrictions: { state: 'unknown', detail: 'Managed-device restrictions are unknown.' } },
      })),
      confirmGuardSession: vi.fn().mockImplementation(() => {
        sessionConsent = true;
        return Promise.resolve(true);
      }),
      revokeGuardSession: vi.fn().mockImplementation(() => {
        sessionConsent = false;
        return Promise.resolve(true);
      }),
      onGuardConsentChanged: vi.fn().mockReturnValue(() => {}),
    };
    window.privacyControls = {
      enterShareSafeMode: vi.fn().mockResolvedValue(true),
      exitShareSafeMode: vi.fn().mockResolvedValue(true),
      onModeChanged: vi.fn().mockReturnValue(() => {}),
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('starts in the compact toolbar and expands on request', async () => {
    render(<App />);
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveProperty('placeholder', 'Expand to review Companion Guard');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Interview Companion' }));
    await screen.findByRole('navigation', { name: 'App views' });
    expect(window.desktop.setWindowMode).toHaveBeenCalledWith('expanded');
  });

  it('requires explicit session consent and displays unknown capture diagnostics', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Interview Companion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Companion Guard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostics' }));
    expect(await screen.findByText('Other capture activity')).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Confirm consent for this session' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I am permitted to use this assistant/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm consent for this session' }));
    await screen.findByText('Session consent confirmed');
    expect(window.desktop.confirmGuardSession).toHaveBeenCalledOnce();
  });

  it('applies restricted mode to chat and microphone controls', async () => {
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(screen.getByRole('button', { name: 'Start microphone recording' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Companion Guard' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Restricted mode/ }));
    expect(stopTrack).toHaveBeenCalledOnce();
    await waitFor(() => expect(window.desktop.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ guard: expect.objectContaining({ restrictedMode: true }) }) }),
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Start microphone recording' })).toHaveProperty('disabled', true);
  });

  it('starts and explicitly transcribes microphone audio from the Guard dashboard', async () => {
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(screen.getByRole('button', { name: 'Companion Guard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start microphone capture' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Stop and discard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    await waitFor(() => expect(window.desktop.transcribe).toHaveBeenCalledOnce());
    expect(stopTrack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'How do you handle a difficult project?');
  });

  it('renders the welcome message and submits a manual chat question', async () => {
    await renderExpandedApp();
    expect(await screen.findByText(/Ask a question or record a short voice note/)).toBeTruthy();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'How does a closure work?' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(window.desktop.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: 'user', text: 'How does a closure work?' })]) }),
      expect.any(Function),
    ));
    expect(screen.getByText('How does a closure work?')).toBeTruthy();
  });

  it('renders streamed chunks and allows the user to cancel generation', async () => {
    let sendEvent: ((event: { requestId: string; delta?: string }) => void) | undefined;
    const cancel = vi.fn();
    vi.mocked(window.desktop.streamChat).mockImplementation((_request, onEvent) => {
      sendEvent = onEvent;
      return cancel;
    });
    await renderExpandedApp();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'Explain a closure' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    act(() => sendEvent?.({ requestId: 'test', delta: 'A closure captures' }));
    expect(await screen.findByText('A closure captures')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('starts recording immediately and pause transcribes into an editable message', async () => {
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Start microphone recording' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(screen.getByRole('status', { name: /Recording in progress/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording and transcribe' }));

    await waitFor(() => expect(window.desktop.transcribe).toHaveBeenCalledOnce());
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'How do you handle a difficult project?');
    expect(window.desktop.streamChat).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('transcribes and sends automatically when send is clicked during recording', async () => {
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Start microphone recording' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe and send recording' }));

    await waitFor(() => expect(window.desktop.transcribe).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.desktop.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: 'user', text: 'How do you handle a difficult project?' })]) }),
      expect.any(Function),
    ));
    await waitFor(() => expect(window.desktop.setWindowMode).toHaveBeenCalledWith('answer'));
    expect(await screen.findByRole('region', { name: 'Latest answer' })).toBeTruthy();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('stops active microphone capture and requires explicit confirmation to leave privacy mode', async () => {
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(screen.getByRole('button', { name: 'Start microphone recording' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect((screen.getByRole('checkbox', { name: /Always on Top/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: /Privacy mode/i }));

    expect(await screen.findByRole('heading', { name: 'Screen-Sharing Mode is active' })).toBeTruthy();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(window.privacyControls.enterShareSafeMode).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Restore interface…' }));
    await waitFor(() => expect(window.privacyControls.exitShareSafeMode).toHaveBeenCalledOnce());
    await screen.findByRole('heading', { name: 'Settings' });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('stops microphone capture when share-safe mode is reported over preload IPC', async () => {
    let reportMode: ((enabled: boolean) => void) | undefined;
    window.privacyControls.onModeChanged = vi.fn(callback => {
      reportMode = callback;
      return () => {};
    });
    const { getUserMedia, stopTrack } = setupMicrophoneRecorder();
    await renderExpandedApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Start microphone recording' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    act(() => reportMode?.(true));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Screen-Sharing Mode is active' })).toBeTruthy();
    expect(screen.getByText(/Microphone and transcription/)).toBeTruthy();
    act(() => reportMode?.(false));
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('shows the screen-sharing privacy checklist in presentation mode', async () => {
    await renderExpandedApp();
    fireEvent.click(screen.getAllByRole('button', { name: 'Presentation mode' })[0]);
    await waitFor(() => expect(screen.getByText(/No window is guaranteed to be excluded/)).toBeTruthy());
    expect(screen.getByText(/checked the sharing application preview/)).toBeTruthy();
    expect(screen.getByText(/Microphone is not recording/)).toBeTruthy();
  });
});

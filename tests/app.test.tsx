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
  fireEvent.click(await screen.findByRole('button', { name: 'Expand chat and settings' }));
  await screen.findByRole('navigation', { name: 'App views' });
}

describe('Interview Companion interface', () => {
  afterEach(() => {
    cleanup();
    delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.desktop = {
      getSettings: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, hasApiKey: true }),
      saveSettings: vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, hasApiKey: true }),
      streamChat: vi.fn().mockReturnValue(() => {}),
      transcribe: vi.fn().mockResolvedValue('How do you handle a difficult project?'),
      minimize: vi.fn(),
      setWindowMode: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn(),
      close: vi.fn(),
    };
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('starts in a compact, clearly identified toolbar without screen capture', async () => {
    render(<App />);
    expect(await screen.findByText('Visible assistant · No screen capture')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' }).getAttribute('placeholder')).toBe('Ask Interview Companion…');
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat and settings' }));
    await screen.findByRole('navigation', { name: 'App views' });
    expect(window.desktop.setWindowMode).toHaveBeenCalledWith('expanded');
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
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('shows the screen-sharing privacy checklist in presentation mode', async () => {
    await renderExpandedApp();
    fireEvent.click(screen.getAllByRole('button', { name: 'Presentation mode' })[0]);
    await waitFor(() => expect(screen.getByText(/No window is guaranteed to be excluded/)).toBeTruthy());
    expect(screen.getByText(/checked the sharing application preview/)).toBeTruthy();
    expect(screen.getByText(/Microphone is not recording/)).toBeTruthy();
  });
});

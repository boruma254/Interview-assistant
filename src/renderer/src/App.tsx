import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { AppSettings, ChatMessage } from '../../shared/contracts';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { applyChatEvent } from '../../shared/chat-state';
import { transitionRecordingState, type RecordingState } from '../../shared/recording-state';
import { PRESENTATION_PRIVACY_NOTICE } from '../../shared/privacy';

type Message = ChatMessage & { id: string; streaming?: boolean; error?: boolean };
const WAVEFORM_HEIGHTS = [5, 10, 16, 8, 21, 12, 27, 15, 9, 23, 12, 19, 7, 26, 13, 20, 8, 16, 25, 10, 18, 6, 22, 12, 27, 9, 17, 7, 23, 13, 19, 5, 15, 25, 10, 20, 8, 17, 27, 11, 21, 6, 14, 24, 9, 18, 5, 13, 22, 10, 19, 7, 26, 12, 16, 8, 23, 11, 18, 6, 14, 25, 9, 20];

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function makeId() {
  return crypto.randomUUID();
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: makeId(), role: 'assistant', text: 'Hi! Ask a question or record a short voice note. I’ll help you practice and explain concepts clearly.' },
  ]);
  const [input, setInput] = useState('');
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading settings…');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentationOpen, setPresentationOpen] = useState(false);
  const [overlayLabOpen, setOverlayLabOpen] = useState(false);
  const [toolbarMode, setToolbarMode] = useState(true);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [presentationChecks, setPresentationChecks] = useState([false, false, false]);
  const busyRef = useRef(false);
  const cancelGenerationRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pendingRecordingActionRef = useRef<'edit' | 'send' | null>(null);
  const startingRecordingRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const elapsedRecordingMsRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastQuestionRef = useRef('');

  useEffect(() => {
    let active = true;
    void window.desktop.getSettings().then(snapshot => {
      if (!active) return;
      setSettings(snapshot.settings);
      setHasApiKey(snapshot.hasApiKey);
      setStatus(snapshot.hasApiKey ? 'Ready' : 'Add an API key in Settings to begin');
    }).catch(error => {
      if (active) setStatus(error instanceof Error ? error.message : 'Could not load settings.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  }, [settings.theme, settings.fontSize]);

  useEffect(() => {
    if (recordingState !== 'recording') return;
    const updateDuration = () => setRecordingSeconds(Math.floor((elapsedRecordingMsRef.current + Date.now() - recordingStartedAtRef.current) / 1000));
    updateDuration();
    const interval = window.setInterval(updateDuration, 250);
    return () => window.clearInterval(interval);
  }, [recordingState]);

  useEffect(() => () => {
    pendingRecordingActionRef.current = null;
    cancelGenerationRef.current?.();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  async function saveSettings(nextSettings: AppSettings, clearApiKey = false) {
    setSettingsError('');
    try {
      const snapshot = await window.desktop.saveSettings({
        settings: nextSettings,
        ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      });
      setSettings(snapshot.settings);
      setHasApiKey(snapshot.hasApiKey);
      setApiKeyInput('');
      setStatus(snapshot.hasApiKey ? 'Settings saved' : 'Add an API key in Settings to begin');
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Settings could not be saved.');
    }
  }

  function ask(question: string, includeUserMessage = true) {
    const clean = question.trim();
    if (!clean || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setInput('');
    lastQuestionRef.current = clean;
    setStatus('Generating response…');
    const requestId = makeId();
    const answerId = makeId();
    const promptMessages = messages.filter(message => !message.error && message.text).map(({ role, text }) => ({ role, text }));
    const requestMessages = includeUserMessage ? [...promptMessages, { role: 'user' as const, text: clean }] : promptMessages;
    setMessages(previous => [
      ...previous.filter(message => !(message.role === 'assistant' && message.error)),
      ...(includeUserMessage ? [{ id: makeId(), role: 'user' as const, text: clean }] : []),
      { id: answerId, role: 'assistant', text: '', streaming: true },
    ]);

    cancelGenerationRef.current = window.desktop.streamChat(
      { requestId, messages: requestMessages, settings },
      event => {
        setMessages(previous => applyChatEvent(previous, answerId, event));
        if (event.error) setStatus('Response failed');
        else if (event.done) setStatus(event.cancelled ? 'Generation stopped' : 'Ready');
        if (event.done) {
          busyRef.current = false;
          setBusy(false);
          cancelGenerationRef.current = null;
        }
      },
    );
  }

  function stopGeneration() {
    cancelGenerationRef.current?.();
    cancelGenerationRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setMessages(previous => previous.map(message => message.streaming ? { ...message, streaming: false } : message));
    setStatus('Generation stopped');
  }

  function submitMessage() {
    if (busyRef.current) return;
    if (recordingState === 'recording' || recordingState === 'paused') {
      stopRecording('send');
      return;
    }
    if (recordingState === 'ready' && recordingBlob) {
      void transcribeRecording(recordingBlob, true);
      return;
    }
    ask(input);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    submitMessage();
  }

  function toggleRecording() {
    if (recordingState === 'recording' || recordingState === 'paused') {
      stopRecording('edit');
      return;
    }
    elapsedRecordingMsRef.current = 0;
    setRecordingSeconds(0);
    setRecordingBlob(null);
    void startRecording();
  }

  function toggleRecordingPause() {
    const recorder = recorderRef.current;
    if (recorder && (recordingState === 'recording' || recordingState === 'paused')) stopRecording('edit');
  }

  async function startRecording() {
    if (startingRecordingRef.current || isTranscribing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Microphone recording is not supported by this device or runtime.');
      return;
    }
    startingRecordingRef.current = true;
    try {
      setStatus('Requesting microphone permission…');
      const audio = settings.microphoneId ? { deviceId: { exact: settings.microphoneId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = event => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const action = pendingRecordingActionRef.current;
        pendingRecordingActionRef.current = null;
        setRecordingBlob(blob);
        audioChunksRef.current = [];
        stream.getTracks().forEach(track => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        setRecordingState(previous => transitionRecordingState(previous, 'stop'));
        setRecordingSeconds(Math.floor(elapsedRecordingMsRef.current / 1000));
        if (action) void transcribeRecording(blob, action === 'send');
        else setStatus('Recording stopped.');
      };
      recorderRef.current = recorder;
      recorder.start();
      startingRecordingRef.current = false;
      recordingStartedAtRef.current = Date.now();
      elapsedRecordingMsRef.current = 0;
      setRecordingSeconds(0);
      setRecordingBlob(null);
      setRecordingState(previous => transitionRecordingState(previous, 'start'));
      setStatus('Microphone recording is active');
      void navigator.mediaDevices.enumerateDevices().then(choices => {
        setMicDevices(choices.filter(device => device.kind === 'audioinput'));
      }).catch(error => {
        console.error('Could not enumerate microphone devices:', error);
      });
    } catch (error) {
      startingRecordingRef.current = false;
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      const name = error instanceof Error ? error.name : '';
      setRecordingState(previous => transitionRecordingState(previous, name === 'NotFoundError' ? 'device-missing' : 'permission-denied'));
      setStatus(name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? 'Microphone permission was denied. Allow microphone access in system settings and try again.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Connect a microphone or choose another device.'
          : 'Could not start recording. Check microphone permissions and device availability.');
    }
  }

  function stopRecording(action: 'edit' | 'send' = 'edit') {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      if (recorder.state === 'recording') elapsedRecordingMsRef.current += Date.now() - recordingStartedAtRef.current;
      pendingRecordingActionRef.current = action;
      setStatus(action === 'send' ? 'Finishing recording to transcribe and send…' : 'Finishing recording to transcribe…');
      recorder.stop();
    } else {
      setStatus('Recording has already stopped.');
    }
    recorderRef.current = null;
  }

  async function transcribeRecording(blob: Blob, sendAfterTranscription = false) {
    setIsTranscribing(true);
    setRecordingBlob(null);
    setStatus(sendAfterTranscription ? 'Transcribing and sending your message…' : 'Sending this recording to OpenAI for transcription…');
    try {
      const base64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
      const transcript = await window.desktop.transcribe(base64, blob.type.split(';')[0] || 'audio/webm');
      setRecordingState(previous => transitionRecordingState(previous, 'transcribed'));
      if (sendAfterTranscription) {
        setInput('');
        ask(transcript);
      } else {
        setInput(transcript);
        setStatus('Transcript ready. Edit it before sending.');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Transcription failed. Your recording is still available to retry.');
      setRecordingBlob(blob);
      setRecordingState('ready');
    } finally {
      setIsTranscribing(false);
    }
  }

  function clearConversation() {
    setMessages([{ id: makeId(), role: 'assistant', text: 'Conversation cleared. What would you like to practice?' }]);
    lastQuestionRef.current = '';
    setStatus('Conversation cleared');
  }

  async function toggleToolbarMode() {
    const nextMode = toolbarMode ? 'expanded' : 'toolbar';
    try {
      await window.desktop.setWindowMode(nextMode);
      setToolbarMode(nextMode === 'toolbar');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not change window layout.');
    }
  }

  return (
    <main className={`app-shell ${toolbarMode ? 'toolbar-mode' : ''}`} aria-label="Interview Companion">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">IC</div>
        <div className="brand-copy"><strong>Interview Companion</strong><span>Visible, user-controlled AI support</span></div>
        <div className="window-actions">
          <button type="button" aria-label={settings.alwaysOnTop ? 'Turn off always on top' : 'Keep window on top'} onClick={() => void saveSettings({ ...settings, alwaysOnTop: !settings.alwaysOnTop })}>{settings.alwaysOnTop ? 'Pinned' : 'Pin'}</button>
          <button type="button" aria-label={toolbarMode ? 'Expand chat and settings' : 'Return to compact toolbar'} onClick={() => void toggleToolbarMode()}>{toolbarMode ? 'Expand' : 'Toolbar'}</button>
          <button type="button" aria-label="Minimize window" onClick={() => void window.desktop.minimize()}>—</button>
          <button type="button" aria-label="Close window" onClick={() => void window.desktop.close()}>×</button>
        </div>
      </header>

      <section className="status-row" aria-live="polite">
        <span className={`status-dot ${recordingState === 'recording' ? 'active' : ''}`} />
        <span>{status}</span>
      </section>

      {toolbarMode ? (
      <>
        <form className="toolbar-composer" onSubmit={submit}>
          <button type="button" className={`mic-button ${recordingState === 'recording' ? 'is-recording' : ''}`} aria-label={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe recording' : 'Start microphone recording'} title={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe for editing' : 'Start recording'} disabled={busy || isTranscribing || startingRecordingRef.current} onClick={toggleRecording}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></svg>
          </button>
          {isTranscribing ? (
            <div className="recording-display is-transcribing" role="status" aria-label="Transcribing recording">
              <span className="recording-copy"><span className="transcribing-indicator" />Transcribing audio…</span>
              <span className="transcribing-progress" aria-hidden="true" />
            </div>
          ) : recordingState === 'recording' || recordingState === 'paused' ? (
            <div className={`recording-display ${recordingState === 'paused' ? 'is-paused' : ''}`} role="status" aria-label={recordingState === 'recording' ? `Recording in progress, ${formatDuration(recordingSeconds)}` : `Recording paused, ${formatDuration(recordingSeconds)}`}>
              <span className="recording-copy"><span className="recording-indicator" />{recordingState === 'recording' ? 'Recording' : 'Paused'} <time>{formatDuration(recordingSeconds)}</time></span>
              <span className="recording-waveform" aria-hidden="true">{WAVEFORM_HEIGHTS.map((height, index) => <i key={index} style={{ '--bar-height': `${height}px`, '--bar-delay': `${(index % 9) * -0.11}s` } as CSSProperties} />)}</span>
            </div>
          ) : (
            <textarea aria-label="Message" value={input} onChange={event => setInput(event.target.value)} placeholder="Ask Interview Companion…" rows={1} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitMessage(); } }} />
          )}
          {(recordingState === 'recording' || recordingState === 'paused') && <button type="button" className="pause-button" aria-label="Pause recording and transcribe" title="Pause and transcribe for editing" onClick={toggleRecordingPause}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></svg>
          </button>}
          {busy ? <button type="button" className="stop-button" aria-label="Stop generation" onClick={stopGeneration}>■</button> : <button className="send-button" type="submit" aria-label={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} title={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} disabled={isTranscribing || startingRecordingRef.current || (recordingState === 'idle' && !input.trim())}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
          </button>}
        </form>
        <div className="toolbar-hint">Visible assistant · No screen capture</div>
      </>
      ) : (
      <>
      <nav className="view-tabs" aria-label="App views">
        <button type="button" aria-pressed={!presentationOpen && !settingsOpen && !overlayLabOpen} onClick={() => { setPresentationOpen(false); setSettingsOpen(false); setOverlayLabOpen(false); }}>Chat</button>
        <button type="button" aria-pressed={overlayLabOpen} onClick={() => { setOverlayLabOpen(true); setSettingsOpen(false); setPresentationOpen(false); }}>Overlay lab</button>
        <button type="button" aria-pressed={presentationOpen} onClick={() => { setPresentationOpen(true); setSettingsOpen(false); setOverlayLabOpen(false); }}>Presentation mode</button>
        <button type="button" aria-pressed={settingsOpen} onClick={() => { setSettingsOpen(true); setPresentationOpen(false); setOverlayLabOpen(false); }}>Settings</button>
      </nav>

      {presentationOpen ? (
        <section className="panel presentation-panel" aria-labelledby="presentation-title">
          <div className="panel-heading"><span className="eyebrow">BEFORE YOU SHARE</span><h1 id="presentation-title">Presentation mode</h1></div>
          <p className="notice">{PRESENTATION_PRIVACY_NOTICE}</p>
          <p className="helper">If your sharing app provides a preview, check that exact preview before you begin. Do not share assistance unless your audience or assessment rules allow it.</p>
          <fieldset className="checklist">
            <legend>My pre-share checklist</legend>
            {[
              'I checked the sharing application preview and selected the intended window, tab, or display.',
              'I have permission to use this assistant in this presentation or assessment.',
              'I checked microphone status and stopped any recording I do not need.',
            ].map((text, index) => <label key={text}><input type="checkbox" checked={presentationChecks[index]} onChange={event => setPresentationChecks(previous => previous.map((checked, item) => item === index ? event.target.checked : checked))} />{text}</label>)}
          </fieldset>
          <div className="presentation-actions">
            <span className={recordingState === 'recording' ? 'recording-label' : 'helper'}>{recordingState === 'recording' ? 'Microphone is recording' : 'Microphone is not recording'}</span>
            <button type="button" className="secondary-button" onClick={() => void window.desktop.minimize()}>Minimize app</button>
            <button type="button" className="danger-button" onClick={() => void window.desktop.close()}>Close app</button>
          </div>
        </section>
      ) : overlayLabOpen ? (
        <section className="panel presentation-panel" aria-labelledby="overlay-lab-title">
          <div className="panel-heading"><span className="eyebrow">LOCAL RESEARCH HARNESS</span><h1 id="overlay-lab-title">Overlay behavior lab</h1></div>
          <p className="notice">Open a companion-owned test window, then observe focus and window behavior on your desktop. The lab uses synthetic local content and does not inspect other apps or connect to websites.</p>
          <div className="lab-observations">
            <article><strong>Browser renderer</strong><span>Reports only its own page focus, visibility, and fullscreen state.</span></article>
            <article><strong>OS window API</strong><span>Controls ordinary always-on-top and workspace requests.</span></article>
            <article><strong>Display composition</strong><span>The OS decides how fullscreen and protected display layers behave.</span></article>
          </div>
          <ol className="lab-steps">
            <li>Keep Interview Companion pinned and open the local test window.</li>
            <li>Switch focus between the test window and another ordinary window; note which is on top.</li>
            <li>Try the test window’s fullscreen control and record whether the overlay remains visible.</li>
            <li>Repeat after turning Pin off and, where available, switching workspaces.</li>
          </ol>
          <p className="helper">Record the operating system, desktop environment, pin state, and observed result. Fullscreen behavior is controlled by the OS.</p>
          <div className="presentation-actions"><button type="button" className="primary-button" onClick={() => void window.desktop.openOverlayLab().catch(error => setStatus(error instanceof Error ? error.message : 'Could not open the local test window.'))}>Open local test window</button></div>
        </section>
      ) : settingsOpen ? (
        <form className="panel settings-panel" onSubmit={event => { event.preventDefault(); void saveSettings(settings); }}>
          <div className="panel-heading"><span className="eyebrow">PREFERENCES</span><h1>Settings</h1></div>
          <label>AI provider
            <select value={settings.aiProvider} disabled><option value="openai">OpenAI (implemented)</option></select>
          </label>
          <label>Model<input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} maxLength={100} /></label>
          <label>API endpoint (optional)<input value={settings.apiEndpoint} onChange={event => setSettings({ ...settings, apiEndpoint: event.target.value })} placeholder="https://api.openai.com/v1" /><span className="helper">A custom endpoint receives your API key and prompts. Use only a provider you trust; HTTPS is required except for localhost.</span></label>
          <label>API key <span className="helper">{hasApiKey ? 'A key is securely stored.' : 'No key configured.'}</span>
            <input type="password" autoComplete="new-password" value={apiKeyInput} onChange={event => setApiKeyInput(event.target.value)} placeholder="Enter a key to store securely" />
          </label>
          <div className="settings-actions">
            <button className="primary-button" type="submit">Save settings</button>
            {hasApiKey && <button className="secondary-button" type="button" onClick={() => void saveSettings(settings, true)}>Delete saved API key</button>}
          </div>
          <label>Speech-to-text provider<select value={settings.speechProvider} disabled><option value="openai">OpenAI transcription (implemented)</option></select></label>
          <label>Microphone<select value={settings.microphoneId} onChange={event => setSettings({ ...settings, microphoneId: event.target.value })}><option value="">System default</option>{micDevices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}</select></label>
          <label>Response style<select value={settings.responseStyle} onChange={event => setSettings({ ...settings, responseStyle: event.target.value as AppSettings['responseStyle'] })}><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
          <label>Maximum response length ({settings.maxResponseLength} tokens)<input type="range" min="100" max="2000" step="100" value={settings.maxResponseLength} onChange={event => setSettings({ ...settings, maxResponseLength: Number(event.target.value) })} /></label>
          <label>Conversation history ({settings.historyLimit} earlier messages)<input type="range" min="0" max="40" step="1" value={settings.historyLimit} onChange={event => setSettings({ ...settings, historyLimit: Number(event.target.value) })} /></label>
          <label>Theme<select value={settings.theme} onChange={event => setSettings({ ...settings, theme: event.target.value as AppSettings['theme'] })}><option value="dark">Navy and teal</option><option value="light">Light</option></select></label>
          <label>Font size ({settings.fontSize}px)<input type="range" min="11" max="20" value={settings.fontSize} onChange={event => setSettings({ ...settings, fontSize: Number(event.target.value) })} /></label>
          <label>Window shortcut<input value={settings.keyboardShortcut} onChange={event => setSettings({ ...settings, keyboardShortcut: event.target.value })} maxLength={80} /></label>
          {settingsError && <p className="error-note" role="alert">{settingsError}</p>}
          <div className="settings-actions"><button className="secondary-button" type="button" onClick={clearConversation}>Clear conversation</button><span className="helper">Conversation messages stay in memory and are not saved to disk.</span></div>
        </form>
      ) : (
        <>
          <section className="voice-card">
            <div className="voice-icon" aria-hidden="true">{recordingState === 'recording' ? '●' : '♫'}</div>
            <div className="voice-copy">
              <strong>{isTranscribing ? 'Transcribing recording' : recordingState === 'recording' ? 'Microphone recording' : recordingState === 'paused' ? 'Recording paused' : recordingState === 'ready' ? 'Recording ready to review' : 'Record a voice note'}</strong>
              <span>{recordingState === 'recording' ? 'Audio is captured locally. Press send to transcribe and send it.' : recordingState === 'ready' ? 'Press send to transcribe and send, or transcribe to edit first.' : 'Tap the microphone below to start recording.'}</span>
            </div>
            {recordingState === 'ready' && recordingBlob && !isTranscribing && <button type="button" className="secondary-button" onClick={() => { void transcribeRecording(recordingBlob); }}>Transcribe to edit</button>}
          </section>

          {recordingState === 'ready' && <p className="privacy-note">Recording is ready. Send it to transcribe and submit, or transcribe it to edit first.</p>}

          <p className="privacy-note">When you send a message, it is sent to your configured AI provider. Conversation history remains in memory only.</p>

          <section className="conversation" aria-label="Conversation" aria-live="polite">
            {messages.map(message => <article key={message.id} className={`message ${message.role}`}>
              <div className="message-label">{message.role === 'user' ? 'YOU' : 'AI SUGGESTION'}</div>
              <div className="message-text">{message.text}{message.streaming && <span className="cursor" aria-label="Response is streaming">▍</span>}</div>
              {message.role === 'assistant' && !message.streaming && !message.error && message.text && <div className="message-actions">
                <button type="button" onClick={() => void navigator.clipboard.writeText(message.text).then(() => setStatus('Response copied')).catch(() => setStatus('Could not access the clipboard.'))}>Copy response</button>
              </div>}
              {message.error && <button type="button" className="retry-button" onClick={() => ask(lastQuestionRef.current, false)}>Retry</button>}
            </article>)}
            <div ref={bottomRef} />
          </section>

          <form className="composer" onSubmit={submit}>
            <button type="button" className={`mic-button ${recordingState === 'recording' ? 'is-recording' : ''}`} aria-label={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe recording' : isTranscribing ? 'Transcription in progress' : 'Start microphone recording'} title={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe for editing' : isTranscribing ? 'Transcription in progress' : 'Start recording'} disabled={busy || isTranscribing || startingRecordingRef.current} onClick={toggleRecording}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></svg>
            </button>
            {isTranscribing ? (
              <div className="recording-display is-transcribing" role="status" aria-label="Transcribing recording">
                <span className="recording-copy"><span className="transcribing-indicator" />Transcribing audio…</span>
                <span className="transcribing-progress" aria-hidden="true" />
              </div>
            ) : recordingState === 'recording' || recordingState === 'paused' ? (
              <div className={`recording-display ${recordingState === 'paused' ? 'is-paused' : ''}`} role="status" aria-label={recordingState === 'recording' ? `Recording in progress, ${formatDuration(recordingSeconds)}` : `Recording paused, ${formatDuration(recordingSeconds)}`}>
                <span className="recording-copy"><span className="recording-indicator" />{recordingState === 'recording' ? 'Recording' : 'Paused'} <time>{formatDuration(recordingSeconds)}</time></span>
                <span className="recording-waveform" aria-hidden="true">{WAVEFORM_HEIGHTS.map((height, index) => <i key={index} style={{ '--bar-height': `${height}px`, '--bar-delay': `${(index % 9) * -0.11}s` } as CSSProperties} />)}</span>
              </div>
            ) : <textarea aria-label="Message" value={input} onChange={event => setInput(event.target.value)} placeholder="Type an interview question…" rows={2} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitMessage(); } }} />}
            {(recordingState === 'recording' || recordingState === 'paused') && <button type="button" className="pause-button" aria-label="Pause recording and transcribe" title="Pause and transcribe for editing" onClick={toggleRecordingPause}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></svg>
            </button>}
            {busy ? <button type="button" className="stop-button" aria-label="Stop generation" onClick={stopGeneration}>■</button> : <button className={`send-button ${recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'send-recording' : ''}`} type="submit" aria-label={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} title={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} disabled={isTranscribing || startingRecordingRef.current || (recordingState === 'idle' && !input.trim())}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
            </button>}
          </form>
          <footer><span>Verify suggestions and follow your organization’s rules.</span><button type="button" onClick={clearConversation}>Clear chat</button><span>Ctrl/⌘ + Shift + Space toggles window</span></footer>
        </>
      )}
      </>
      )}
    </main>
  );
}

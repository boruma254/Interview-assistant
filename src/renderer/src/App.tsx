import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { AppSettings, ChatMessage, GuardDiagnostics, GuardPolicySettings } from '../../shared/contracts';
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

function formatGuardState(state: string) {
  return state.replaceAll('-', ' ');
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
  const [guardOpen, setGuardOpen] = useState(false);
  const [guardDiagnostics, setGuardDiagnostics] = useState<GuardDiagnostics | null>(null);
  const [guardLoading, setGuardLoading] = useState(false);
  const [guardError, setGuardError] = useState('');
  const [guardSessionConsent, setGuardSessionConsent] = useState(false);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micMeterError, setMicMeterError] = useState('');
  const [answerView, setAnswerView] = useState(false);
  const [toolbarMode, setToolbarMode] = useState(true);
  const [privacyActive, setPrivacyActive] = useState(false);
  const [privacyPending, setPrivacyPending] = useState(false);
  const [privacyError, setPrivacyError] = useState('');
  const [transcriptionPaused, setTranscriptionPaused] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [presentationChecks, setPresentationChecks] = useState([false, false, false]);
  const busyRef = useRef(false);
  const cancelGenerationRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pendingRecordingActionRef = useRef<'edit' | 'send' | null>(null);
  const startingRecordingRef = useRef(false);
  const privacyActiveRef = useRef(false);
  const privacyTransitionRef = useRef(false);
  const privacyGenerationRef = useRef(0);
  const guardGenerationRef = useRef(0);
  const captureGenerationRef = useRef(0);
  const stopMicrophoneCaptureRef = useRef<() => void>(() => {});
  const recordingStartedAtRef = useRef(0);
  const elapsedRecordingMsRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastQuestionRef = useRef('');
  const guardPolicyRef = useRef(settings.guard);
  guardPolicyRef.current = settings.guard;

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
    void window.desktop.getGuardDiagnostics().then(diagnostics => {
      if (!active) return;
      setGuardDiagnostics(diagnostics);
      setGuardSessionConsent(diagnostics.sessionConsent);
    }).catch(error => {
      if (active) setGuardError(error instanceof Error ? error.message : 'Could not load Companion Guard status.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribeConsent = window.desktop.onGuardConsentChanged(confirmed => {
      setGuardSessionConsent(confirmed);
      setConsentAcknowledged(false);
      if (!confirmed) {
        stopMicrophoneCaptureRef.current();
        cancelGenerationRef.current?.();
        cancelGenerationRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    });
    const applyPrivacyStatus = (privacy: { active: boolean; alwaysOnTop: boolean }) => {
      privacyActiveRef.current = privacy.active;
      setPrivacyActive(privacy.active);
      if (privacy.active) setTranscriptionPaused(true);
      setSettings(previous => ({ ...previous, alwaysOnTop: privacy.alwaysOnTop }));
    };
    const unsubscribeStatus = window.desktop.onPrivacyStateChanged(applyPrivacyStatus);
    const unsubscribeMode = window.privacyControls.onModeChanged(enabled => {
      if (enabled) {
        privacyActiveRef.current = true;
        privacyGenerationRef.current += 1;
        cancelGenerationRef.current?.();
        cancelGenerationRef.current = null;
        busyRef.current = false;
        setBusy(false);
        stopMicrophoneCaptureRef.current();
        setTranscriptionPaused(true);
        setPrivacyActive(true);
        setStatus('Screen-sharing privacy is active. Microphone and transcription are paused.');
        return;
      }
      setTranscriptionPaused(true);
      setPrivacyActive(false);
      privacyActiveRef.current = false;
    });
    void window.desktop.getPrivacyStatus().then(privacy => {
      if (active) applyPrivacyStatus(privacy);
    }).catch(error => {
      if (active) setPrivacyError(error instanceof Error ? error.message : 'Could not read privacy status.');
    });
    return () => { active = false; unsubscribeStatus(); unsubscribeMode(); unsubscribeConsent(); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.compact = toolbarMode ? 'true' : 'false';
    document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  }, [settings.theme, settings.fontSize, toolbarMode]);

  useEffect(() => {
    if (recordingState !== 'recording') return;
    const updateDuration = () => setRecordingSeconds(Math.floor((elapsedRecordingMsRef.current + Date.now() - recordingStartedAtRef.current) / 1000));
    updateDuration();
    const interval = window.setInterval(updateDuration, 250);
    return () => window.clearInterval(interval);
  }, [recordingState]);

  useEffect(() => {
    const stream = streamRef.current;
    if (recordingState !== 'recording' || !stream) {
      setMicLevel(0);
      return;
    }
    if (typeof window.AudioContext === 'undefined') {
      setMicMeterError('This runtime does not provide an audio-level meter.');
      return;
    }

    let context: AudioContext;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(error => {
        setMicMeterError(error instanceof Error ? `Audio-level meter unavailable: ${error.message}` : 'Audio-level meter unavailable.');
      });
      const samples = new Uint8Array(analyser.fftSize);
      let frame = 0;
      let lastUpdate = 0;
      setMicMeterError('');
      const sampleLevel = (timestamp: number) => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + (sample - 128) ** 2, 0) / samples.length);
        if (timestamp - lastUpdate >= 100) {
          setMicLevel(Math.min(100, Math.round(rms * 2)));
          lastUpdate = timestamp;
        }
        frame = window.requestAnimationFrame(sampleLevel);
      };
      frame = window.requestAnimationFrame(sampleLevel);
      return () => {
        window.cancelAnimationFrame(frame);
        void context.close().catch(error => console.warn('Could not close the microphone level meter:', error));
      };
    } catch (error) {
      setMicMeterError(error instanceof Error ? `Audio-level meter unavailable: ${error.message}` : 'Audio-level meter unavailable.');
      return;
    }
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

  async function updateGuardPolicy(nextPolicy: GuardPolicySettings) {
    const nextSettings = { ...settings, guard: nextPolicy };
    const previousSettings = settings;
    guardPolicyRef.current = nextPolicy;
    setSettings(nextSettings);
    setSettingsError('');
    if (nextPolicy.restrictedMode || (previousSettings.guard.allowTranscription && !nextPolicy.allowTranscription)) {
      guardGenerationRef.current += 1;
      setIsTranscribing(false);
      setRecordingBlob(null);
    }
    if (nextPolicy.restrictedMode || !nextPolicy.allowAiAssistance) {
      cancelGenerationRef.current?.();
      cancelGenerationRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
    if (nextPolicy.restrictedMode || !nextPolicy.allowMicrophoneRecording) {
      stopMicrophoneCapture();
    }
    try {
      const snapshot = await window.desktop.saveSettings({ settings: nextSettings });
      setSettings(snapshot.settings);
      setHasApiKey(snapshot.hasApiKey);
    } catch (error) {
      guardPolicyRef.current = previousSettings.guard;
      setSettings(previousSettings);
      setSettingsError(error instanceof Error ? error.message : 'Companion Guard policy could not be saved.');
      return;
    }
    await runGuardDiagnostics();
  }

  async function runGuardDiagnostics() {
    setGuardLoading(true);
    setGuardError('');
    try {
      const diagnostics = await window.desktop.getGuardDiagnostics();
      setGuardDiagnostics(diagnostics);
      setGuardSessionConsent(diagnostics.sessionConsent);
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : 'Companion Guard diagnostics could not be run.');
    } finally {
      setGuardLoading(false);
    }
  }

  async function confirmGuardSession() {
    setGuardError('');
    try {
      const confirmed = await window.desktop.confirmGuardSession();
      setGuardSessionConsent(confirmed);
      setConsentAcknowledged(false);
      await runGuardDiagnostics();
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : 'Session consent could not be recorded.');
    }
  }

  async function revokeGuardSession() {
    stopMicrophoneCapture();
    cancelGenerationRef.current?.();
    cancelGenerationRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setGuardError('');
    try {
      const revoked = await window.desktop.revokeGuardSession();
      setGuardSessionConsent(!revoked);
      setConsentAcknowledged(false);
      await runGuardDiagnostics();
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : 'Session consent could not be revoked.');
    }
  }

  async function setAlwaysOnTop(value: boolean) {
    setSettingsError('');
    try {
      const saved = await window.desktop.setAlwaysOnTop(value);
      setSettings(previous => ({ ...previous, alwaysOnTop: saved }));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Always-on-Top preference could not be saved.');
    }
  }

  function ask(question: string, includeUserMessage = true) {
    const clean = question.trim();
    if (!clean || busyRef.current || privacyActiveRef.current) return;
    if (!guardSessionConsent) {
      setStatus('Open Companion Guard and confirm consent for this session before using AI assistance.');
      return;
    }
    if (settings.guard.restrictedMode || !settings.guard.allowAiAssistance) {
      setStatus('AI assistance is disabled by the Companion Guard policy.');
      return;
    }
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
    if (busyRef.current || privacyActiveRef.current) return;
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
    if (privacyActiveRef.current) return;
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
    if (privacyActiveRef.current || startingRecordingRef.current || isTranscribing) return;
    if (!guardSessionConsent) {
      setStatus('Open Companion Guard and confirm consent before recording.');
      return;
    }
    if (settings.guard.restrictedMode || !settings.guard.allowMicrophoneRecording) {
      setStatus('Microphone recording is disabled by the Companion Guard policy.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('Microphone recording is not supported by this device or runtime.');
      return;
    }
    setTranscriptionPaused(false);
    startingRecordingRef.current = true;
    const captureGeneration = ++captureGenerationRef.current;
    try {
      setStatus('Requesting microphone permission…');
      const audio = settings.microphoneId ? { deviceId: { exact: settings.microphoneId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (privacyActiveRef.current || captureGeneration !== captureGenerationRef.current) {
        startingRecordingRef.current = false;
        stream.getTracks().forEach(track => track.stop());
        return;
      }
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
        audioChunksRef.current = [];
        stream.getTracks().forEach(track => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (privacyActiveRef.current || captureGeneration !== captureGenerationRef.current) return;
        if (!guardPolicyRef.current.allowTranscription || guardPolicyRef.current.restrictedMode) {
          setRecordingBlob(null);
          setRecordingState('idle');
          setRecordingSeconds(0);
          setStatus('Microphone stopped. The local recording was discarded because transcription is disabled.');
          return;
        }
        setRecordingBlob(blob);
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
      if (privacyActiveRef.current || captureGeneration !== captureGenerationRef.current) {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        return;
      }
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

  function stopMicrophoneCapture() {
    guardGenerationRef.current += 1;
    captureGenerationRef.current += 1;
    startingRecordingRef.current = false;
    pendingRecordingActionRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      console.error('Could not stop the microphone recorder cleanly:', error);
    } finally {
      streamRef.current?.getTracks().forEach(track => track.stop());
    }
    streamRef.current = null;
    audioChunksRef.current = [];
    setRecordingBlob(null);
    setRecordingState('idle');
    setRecordingSeconds(0);
    setIsTranscribing(false);
    setTranscriptionPaused(true);
  }
  stopMicrophoneCaptureRef.current = stopMicrophoneCapture;

  async function enablePrivacyMode() {
    if (privacyTransitionRef.current || privacyActiveRef.current) return;
    privacyTransitionRef.current = true;
    privacyActiveRef.current = true;
    privacyGenerationRef.current += 1;
    setPrivacyPending(true);
    setPrivacyError('');
    cancelGenerationRef.current?.();
    cancelGenerationRef.current = null;
    busyRef.current = false;
    setBusy(false);
    stopMicrophoneCapture();
    try {
      const enabled = await window.privacyControls.enterShareSafeMode();
      privacyActiveRef.current = enabled;
      setPrivacyActive(enabled);
      if (enabled) setTranscriptionPaused(true);
    } catch (error) {
      privacyActiveRef.current = false;
      setPrivacyActive(false);
      setPrivacyError(error instanceof Error ? error.message : 'Could not enable Screen-Sharing Privacy Mode.');
    } finally {
      privacyTransitionRef.current = false;
      setPrivacyPending(false);
    }
  }

  async function disablePrivacyMode() {
    if (privacyTransitionRef.current || !privacyActiveRef.current) return;
    privacyTransitionRef.current = true;
    setPrivacyPending(true);
    setPrivacyError('');
    try {
      const restored = await window.privacyControls.exitShareSafeMode();
      if (restored) {
        privacyActiveRef.current = false;
        setPrivacyActive(false);
        setTranscriptionPaused(true);
      }
    } catch (error) {
      setPrivacyError(error instanceof Error ? error.message : 'Could not restore the interface.');
    } finally {
      privacyTransitionRef.current = false;
      setPrivacyPending(false);
    }
  }

  async function transcribeRecording(blob: Blob, sendAfterTranscription = false) {
    if (privacyActiveRef.current) return;
    if (!guardSessionConsent || settings.guard.restrictedMode || !settings.guard.allowTranscription) {
      setStatus('Transcription is disabled by the Companion Guard policy or session consent.');
      return;
    }
    const privacyGeneration = privacyGenerationRef.current;
    const guardGeneration = guardGenerationRef.current;
    setIsTranscribing(true);
    setRecordingBlob(null);
    setStatus(sendAfterTranscription ? 'Transcribing and sending your message…' : 'Sending this recording to OpenAI for transcription…');
    try {
      if (sendAfterTranscription) {
        await window.desktop.setWindowMode('answer');
        setToolbarMode(false);
        setAnswerView(true);
      }
      const base64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
      const transcript = await window.desktop.transcribe(base64, blob.type.split(';')[0] || 'audio/webm', makeId());
      if (privacyActiveRef.current || privacyGeneration !== privacyGenerationRef.current || guardGeneration !== guardGenerationRef.current) return;
      setRecordingState(previous => transitionRecordingState(previous, 'transcribed'));
      if (sendAfterTranscription) {
        setInput('');
        ask(transcript);
      } else {
        setInput(transcript);
        setStatus('Transcript ready. Edit it before sending.');
      }
    } catch (error) {
      if (privacyActiveRef.current || privacyGeneration !== privacyGenerationRef.current || guardGeneration !== guardGenerationRef.current) return;
      setStatus(error instanceof Error ? error.message : 'Transcription failed. Your recording is still available to retry.');
      setRecordingBlob(blob);
      setRecordingState('ready');
      if (sendAfterTranscription) {
        setAnswerView(false);
        try {
          await window.desktop.setWindowMode('toolbar');
          setToolbarMode(true);
        } catch {
          setStatus('Transcription failed. Your recording is available to retry.');
        }
      }
    } finally {
      if (!privacyActiveRef.current && privacyGeneration === privacyGenerationRef.current && guardGeneration === guardGenerationRef.current) setIsTranscribing(false);
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
      setAnswerView(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not change window layout.');
    }
  }

  async function returnToCompactToolbar() {
    try {
      await window.desktop.setWindowMode('toolbar');
      setAnswerView(false);
      setToolbarMode(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not return to the compact toolbar.');
    }
  }

  const latestAnswer = [...messages].reverse().find(message => message.role === 'assistant');
  const canUseAI = guardSessionConsent && !settings.guard.restrictedMode && settings.guard.allowAiAssistance;
  const canRecord = guardSessionConsent
    && !settings.guard.restrictedMode
    && settings.guard.allowMicrophoneRecording;
  const hasPermissionIssue = guardDiagnostics
    && [guardDiagnostics.audio.microphonePermission, guardDiagnostics.display.screenRecordingPermission]
      .some(check => check.state === 'denied' || check.state === 'restricted');
  const guardOverallStatus = settings.guard.restrictedMode
    ? 'Restricted mode'
    : !guardSessionConsent
      ? 'Session consent required'
      : !guardDiagnostics
        ? 'Diagnostics not run'
        : hasPermissionIssue
          ? 'Review permissions'
          : 'Some states are unknown';

  if (privacyActive) {
    return (
      <main className="app-shell privacy-screen" aria-labelledby="privacy-active-title">
        <section className="privacy-card">
          <span className="eyebrow">SCREEN-SHARING PRIVACY</span>
          <h1 id="privacy-active-title">Screen-Sharing Mode is active</h1>
          <p>The companion is hidden from the desktop. Microphone transcription is paused, new AI requests are blocked, and sensitive content is not displayed.</p>
          <p className="privacy-status-line"><strong>Microphone and transcription:</strong> {transcriptionPaused ? 'Paused' : 'Stopped'}</p>
          <p className="privacy-status-line"><strong>Always-on-Top preference:</strong> {settings.alwaysOnTop ? 'On' : 'Off'} (saved)</p>
          <div className="privacy-actions">
            <button type="button" className="primary-button" disabled={privacyPending} onClick={() => void disablePrivacyMode()}>{privacyPending ? 'Waiting…' : 'Restore interface…'}</button>
            <button type="button" className="secondary-button" disabled={privacyPending} onClick={() => void window.desktop.hidePrivacyPrompt()}>Keep hidden</button>
          </div>
          {privacyError && <p className="error-note" role="alert">{privacyError}</p>}
          <p className="helper">Restoring requires confirmation. The microphone will not restart automatically. Use {settings.keyboardShortcut} to reopen this status screen.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${toolbarMode ? 'toolbar-mode' : ''}`} aria-label="Interview Companion">
      {toolbarMode ? (
        <button type="button" className="toolbar-expand" aria-label="Expand Interview Companion" title="Expand Interview Companion" onClick={() => void toggleToolbarMode()}>↗</button>
      ) : !answerView ? (
        <header className="topbar">
          <div className="brand-mark" aria-hidden="true">IC</div>
          <div className="brand-copy"><strong>Interview Companion</strong><span>Visible, user-controlled AI support</span></div>
          <div className="window-actions">
            <button type="button" aria-label={settings.alwaysOnTop ? 'Turn off always on top' : 'Keep window on top'} onClick={() => void setAlwaysOnTop(!settings.alwaysOnTop)}>{settings.alwaysOnTop ? 'Pinned' : 'Pin'}</button>
            <button type="button" aria-label="Return to compact toolbar" onClick={() => void toggleToolbarMode()}>Toolbar</button>
            <button type="button" aria-label="Minimize window" onClick={() => void window.desktop.minimize()}>—</button>
            <button type="button" aria-label="Close window" onClick={() => void window.desktop.close()}>×</button>
          </div>
        </header>
      ) : null}

      {!toolbarMode && !answerView && <section className="status-row" aria-live="polite">
        <span className={`status-dot ${recordingState === 'recording' ? 'active' : ''}`} />
        <span>{status}</span>
      </section>}

      {toolbarMode ? (
      <>
        <form className="toolbar-composer" onSubmit={submit}>
          <button type="button" className={`mic-button ${recordingState === 'recording' ? 'is-recording' : ''}`} aria-label={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe recording' : 'Start microphone recording'} title={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe for editing' : canRecord ? 'Start recording' : 'Expand to review Companion Guard policy and consent'} disabled={busy || isTranscribing || startingRecordingRef.current || (!canRecord && recordingState !== 'recording' && recordingState !== 'paused')} onClick={toggleRecording}>
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
          <textarea aria-label="Message" value={input} onChange={event => setInput(event.target.value)} placeholder={canUseAI ? 'Type an interview question…' : 'Expand to review Companion Guard'} rows={1} disabled={busy || !canUseAI} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitMessage(); } }} />
          )}
          {(recordingState === 'recording' || recordingState === 'paused') && <button type="button" className="pause-button" aria-label="Pause recording and transcribe" title="Pause and transcribe for editing" onClick={toggleRecordingPause}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></svg>
          </button>}
          {busy ? <button type="button" className="stop-button" aria-label="Stop generation" onClick={stopGeneration}>■</button> : <button className="send-button" type="submit" aria-label={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} title={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} disabled={isTranscribing || startingRecordingRef.current || ((recordingState === 'idle' && (!input.trim() || !canUseAI)) || (recordingState !== 'idle' && (!canRecord || !settings.guard.allowTranscription)))}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
          </button>}
        </form>
      </>
      ) : answerView ? (
        <section className="answer-view-content" aria-label="Latest answer" aria-live="polite">
          <button type="button" className="answer-return-button" aria-label="Return to compact toolbar" title="Return to compact toolbar" onClick={() => void returnToCompactToolbar()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></svg>
          </button>
          <div className="answer-response">{isTranscribing ? 'Transcribing recording…' : busy && !latestAnswer?.streaming ? 'Preparing your answer…' : latestAnswer?.text || 'Preparing your answer…'}{latestAnswer?.streaming && <span className="cursor" aria-label="Response is streaming">▍</span>}</div>
        </section>
      ) : (
      <>
      <nav className="view-tabs" aria-label="App views">
        <button type="button" aria-pressed={!presentationOpen && !settingsOpen && !overlayLabOpen && !guardOpen} onClick={() => { setPresentationOpen(false); setSettingsOpen(false); setOverlayLabOpen(false); setGuardOpen(false); }}>Chat</button>
        <button type="button" aria-pressed={guardOpen} onClick={() => { setGuardOpen(true); setPresentationOpen(false); setSettingsOpen(false); setOverlayLabOpen(false); }}>Companion Guard</button>
        <button type="button" aria-pressed={overlayLabOpen} onClick={() => { setOverlayLabOpen(true); setSettingsOpen(false); setPresentationOpen(false); setGuardOpen(false); }}>Overlay lab</button>
        <button type="button" aria-pressed={presentationOpen} onClick={() => { setPresentationOpen(true); setSettingsOpen(false); setOverlayLabOpen(false); setGuardOpen(false); }}>Presentation mode</button>
        <button type="button" aria-pressed={settingsOpen} onClick={() => { setSettingsOpen(true); setPresentationOpen(false); setOverlayLabOpen(false); setGuardOpen(false); }}>Settings</button>
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
      ) : guardOpen ? (
        <section className="panel guard-panel" aria-labelledby="guard-title">
          <div className="panel-heading guard-heading">
            <div><span className="eyebrow">PRIVACY · PERMISSIONS · DIAGNOSTICS</span><h1 id="guard-title">Companion Guard</h1></div>
            <span className={`guard-status-pill ${hasPermissionIssue ? 'attention' : ''}`} role="status">{guardOverallStatus}</span>
          </div>
          <p className="notice">Guard reports this app’s own state and documented operating-system permission signals. It does not inspect security software, detect all recording activity, or guarantee what another app can see.</p>
          <div className="guard-summary">
            <span>Platform <strong>{guardDiagnostics?.platform ?? 'Not checked'}</strong></span>
            <span>Last checked <strong>{guardDiagnostics ? new Date(guardDiagnostics.checkedAt).toLocaleTimeString() : 'Not run'}</strong></span>
            <button type="button" className="primary-button" disabled={guardLoading} onClick={() => void runGuardDiagnostics()}>{guardLoading ? 'Checking…' : 'Run diagnostics'}</button>
          </div>
          {guardError && <p className="error-note" role="alert">{guardError}</p>}

          <div className="guard-grid">
            <section className="guard-card" aria-labelledby="guard-display-title">
              <span className="eyebrow">DISPLAY</span><h2 id="guard-display-title">Display diagnostics</h2>
              <dl>
                <dt>Companion window</dt><dd>{guardDiagnostics?.window.visible === null ? 'Unavailable' : guardDiagnostics?.window.visible ? 'Visible' : guardDiagnostics ? 'Hidden' : 'Not checked'}</dd>
                <dt>Always on top</dt><dd>{guardDiagnostics?.window.alwaysOnTop === null ? 'Unavailable' : guardDiagnostics?.window.alwaysOnTop ? 'On' : guardDiagnostics ? 'Off' : 'Not checked'}</dd>
                <dt>Screen-recording permission</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.display.screenRecordingPermission.state) : 'Not checked'}</dd>
                <dt>Other capture activity</dt><dd>Unknown</dd>
              </dl>
              <p>{guardDiagnostics?.display.screenRecordingPermission.detail ?? 'Run diagnostics to query supported operating-system permission status.'}</p>
              <p>{guardDiagnostics?.display.captureActivity.detail ?? 'This app cannot reliably determine whether another app is capturing the display.'}</p>
              <p>Window visibility and permission status do not prove what a meeting app, screen recorder, or remote session captures.</p>
            </section>

            <section className="guard-card" aria-labelledby="guard-recording-title">
              <span className="eyebrow">SCREEN RECORDING</span><h2 id="guard-recording-title">Screen-recording diagnostics</h2>
              <dl>
                <dt>Platform permission</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.display.screenRecordingPermission.state) : 'Not checked'}</dd>
                <dt>Capture activity</dt><dd>Unknown</dd>
                <dt>Companion capture</dt><dd>{privacyActive ? 'Privacy mode active' : 'No display capture started by this app'}</dd>
              </dl>
              <p>On macOS, the permission result comes from Electron’s documented screen-access status. Windows does not provide an equivalent general permission indicator here. Neither result detects every active screen capture.</p>
              <p>Check the sharing app’s own preview. Guard never hides the app from monitoring or claims capture exclusion.</p>
            </section>

            <section className="guard-card" aria-labelledby="guard-audio-title">
              <span className="eyebrow">AUDIO</span><h2 id="guard-audio-title">Audio diagnostics</h2>
              <dl>
                <dt>Microphone permission</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.audio.microphonePermission.state) : 'Not checked'}</dd>
                <dt>Microphone capture</dt><dd>{recordingState === 'recording' ? 'Active — user started' : recordingState === 'paused' ? 'Paused' : 'Inactive'}</dd>
                <dt>Transcription</dt><dd>{isTranscribing ? 'Active — sending audio to OpenAI' : settings.guard.allowTranscription && !settings.guard.restrictedMode ? 'Allowed by policy; starts only after user action' : 'Disabled by policy'}</dd>
                <dt>System audio</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.audio.systemAudioCapture.state) : 'Not checked'}</dd>
              </dl>
              <label className="guard-level">
                <span>Microphone input level {recordingState === 'recording' ? '(live)' : '(available while recording)'}</span>
                <meter aria-label="Microphone input level" min="0" max="100" value={micLevel} />
              </label>
              {micMeterError && <p role="status">{micMeterError}</p>}
              <p>{guardDiagnostics?.audio.microphonePermission.detail ?? 'Run diagnostics to query microphone permission status.'}</p>
              <p>{guardDiagnostics?.audio.systemAudioCapture.detail ?? 'System audio is not captured by this app.'} Transcription uses the existing OpenAI transcription service after you explicitly stop and submit a recording.</p>
              <div className="guard-audio-actions">
                {recordingState === 'recording' ? (
                  <>
                    <button type="button" className="primary-button" disabled={!settings.guard.allowTranscription || settings.guard.restrictedMode} onClick={() => stopRecording('edit')}>Stop and transcribe</button>
                    <button type="button" className="danger-button" onClick={stopMicrophoneCapture}>Stop and discard</button>
                  </>
                ) : (
                  <button type="button" className="primary-button" disabled={!canRecord || isTranscribing || startingRecordingRef.current} onClick={() => void startRecording()}>Start microphone capture</button>
                )}
              </div>
            </section>

            <section className="guard-card" aria-labelledby="guard-device-title">
              <span className="eyebrow">DEVICE</span><h2 id="guard-device-title">Device diagnostics</h2>
              <dl>
                <dt>Managed restrictions</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.device.restrictions.state) : 'Not checked'}</dd>
                <dt>Microphone restrictions</dt><dd>{guardDiagnostics ? formatGuardState(guardDiagnostics.audio.microphonePermission.state) : 'Not checked'}</dd>
              </dl>
              <p>{guardDiagnostics?.device.restrictions.detail ?? 'No general managed-device signal is queried.'}</p>
              <p>Guard does not enumerate processes or inspect third-party security, assessment, or monitoring software.</p>
            </section>
          </div>

          <section className="guard-card guard-policy" aria-labelledby="guard-policy-title">
            <span className="eyebrow">SESSION CONSENT & POLICY</span><h2 id="guard-policy-title">Choose what this session may use</h2>
            <p>These preferences are saved on this device. Session consent is temporary and resets when the app restarts. AI messages and transcriptions are sent to the configured OpenAI-compatible provider when you submit them.</p>
            <label className="privacy-toggle-row">
              <input type="checkbox" checked={settings.guard.allowAiAssistance} disabled={settings.guard.restrictedMode} onChange={event => void updateGuardPolicy({ ...settings.guard, allowAiAssistance: event.target.checked })} />
              <span><strong>Allow AI assistance</strong><small>Allow submitted text to be sent to the configured provider.</small></span>
            </label>
            <label className="privacy-toggle-row">
              <input type="checkbox" checked={settings.guard.allowMicrophoneRecording} disabled={settings.guard.restrictedMode} onChange={event => void updateGuardPolicy({ ...settings.guard, allowMicrophoneRecording: event.target.checked })} />
              <span><strong>Allow microphone recording</strong><small>Microphone capture begins only from the recording control, after session consent and OS permission.</small></span>
            </label>
            <label className="privacy-toggle-row">
              <input type="checkbox" checked={settings.guard.allowTranscription} disabled={settings.guard.restrictedMode} onChange={event => void updateGuardPolicy({ ...settings.guard, allowTranscription: event.target.checked })} />
              <span><strong>Allow OpenAI transcription</strong><small>Stopped audio is sent to the configured provider only when you choose to transcribe or send it.</small></span>
            </label>
            <label className="privacy-toggle-row restricted-toggle">
              <input type="checkbox" checked={settings.guard.restrictedMode} onChange={event => void updateGuardPolicy({
                ...settings.guard,
                restrictedMode: event.target.checked,
              })} />
              <span><strong>Restricted mode</strong><small>When enabled, recording, transcription, and AI assistance are blocked in the main process.</small></span>
            </label>
            {!guardSessionConsent ? (
              <>
                <label className="guard-consent-check">
                  <input type="checkbox" checked={consentAcknowledged} onChange={event => setConsentAcknowledged(event.target.checked)} />
                  <span>I am permitted to use this assistant for this session, and I understand that submitted messages and audio may be sent to the configured provider.</span>
                </label>
                <button type="button" className="primary-button" disabled={!consentAcknowledged || guardLoading} onClick={() => void confirmGuardSession()}>Confirm consent for this session</button>
              </>
            ) : (
              <div className="guard-consent-confirmed" role="status">
                <strong>Session consent confirmed</strong>
                <button type="button" className="secondary-button" onClick={() => void revokeGuardSession()}>Revoke session consent</button>
              </div>
            )}
            {settingsError && <p className="error-note" role="alert">{settingsError}</p>}
          </section>
        </section>
      ) : settingsOpen ? (
        <form className="panel settings-panel" onSubmit={event => { event.preventDefault(); void saveSettings(settings); }}>
          <div className="panel-heading"><span className="eyebrow">PREFERENCES</span><h1>Settings</h1></div>
          <section className="privacy-settings" aria-labelledby="privacy-settings-title">
            <div className="panel-heading"><span className="eyebrow">MEETINGS & PRESENTATIONS</span><h2 id="privacy-settings-title">Screen-sharing privacy</h2></div>
            <div className="privacy-status-box" role="status">
              <strong>{privacyPending ? 'Updating…' : privacyActive ? 'Privacy active' : 'Ready'}</strong>
              <span>Control what the companion does before you share your display.</span>
              <span>Microphone/transcription: {transcriptionPaused || privacyActive ? 'Paused' : isTranscribing ? 'Transcription in progress' : recordingState === 'recording' || recordingState === 'paused' ? 'Microphone active' : 'Stopped'}</span>
            </div>
            <label className="privacy-toggle-row">
              <input type="checkbox" role="switch" checked={privacyActive} disabled={privacyPending} onChange={event => { if (event.target.checked) void enablePrivacyMode(); }} />
              <span>
                <strong>Privacy mode <em className="privacy-mode-flag" aria-hidden="true">{privacyActive ? 'ON' : 'OFF'}</em></strong>
                <small>{privacyActive ? 'The companion is hidden. Restore requires confirmation and will not restart the microphone.' : 'The companion is currently operating normally.'}</small>
              </span>
            </label>
            <label className="privacy-toggle-row">
              <input type="checkbox" checked={settings.alwaysOnTop} onChange={event => void setAlwaysOnTop(event.target.checked)} />
              <span><strong>Always on Top</strong><small>Keep the companion above ordinary application windows. This preference is saved and does not hide the window when turned off.</small></span>
            </label>
            {privacyError && <p className="error-note" role="alert">{privacyError}</p>}
          </section>
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
            {!guardSessionConsent && <section className="guard-consent-banner" role="status">
              <div><strong>Session consent is required</strong><span>Review Companion Guard and confirm that this session is permitted before using AI or microphone features.</span></div>
              <button type="button" className="secondary-button" onClick={() => { setGuardOpen(true); setSettingsOpen(false); setPresentationOpen(false); setOverlayLabOpen(false); }}>Open Companion Guard</button>
            </section>}
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
            <button type="button" className={`mic-button ${recordingState === 'recording' ? 'is-recording' : ''}`} aria-label={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe recording' : isTranscribing ? 'Transcription in progress' : 'Start microphone recording'} title={recordingState === 'recording' || recordingState === 'paused' ? 'Stop and transcribe for editing' : isTranscribing ? 'Transcription in progress' : canRecord ? 'Start recording' : 'Review Companion Guard policy and consent'} disabled={busy || isTranscribing || startingRecordingRef.current || (!canRecord && recordingState !== 'recording' && recordingState !== 'paused')} onClick={toggleRecording}>
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
            ) : <textarea aria-label="Message" value={input} onChange={event => setInput(event.target.value)} placeholder={canUseAI ? 'Type an interview question…' : 'Review Companion Guard policy and session consent'} rows={2} disabled={busy || !canUseAI} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitMessage(); } }} />}
            {(recordingState === 'recording' || recordingState === 'paused') && <button type="button" className="pause-button" aria-label="Pause recording and transcribe" title="Pause and transcribe for editing" onClick={toggleRecordingPause}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></svg>
            </button>}
            {busy ? <button type="button" className="stop-button" aria-label="Stop generation" onClick={stopGeneration}>■</button> : <button className={`send-button ${recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'send-recording' : ''}`} type="submit" aria-label={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} title={recordingState === 'recording' || recordingState === 'paused' || recordingState === 'ready' ? 'Transcribe and send recording' : 'Send message'} disabled={isTranscribing || startingRecordingRef.current || ((recordingState === 'idle' && (!input.trim() || !canUseAI)) || (recordingState !== 'idle' && (!canRecord || !settings.guard.allowTranscription)))}>
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

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, screen, session, shell, systemPreferences } from 'electron';
import { resolve, join } from 'node:path';
import dotenv from 'dotenv';
import type { ChatEvent, ChatRequest, GuardDiagnostics, SettingsInput, TranscriptRequest } from '../shared/contracts';
import { isChatRequest, isSettingsInput, isTranscriptRequest } from '../shared/settings';
import { OpenAIProvider, OpenAITranscriptionProvider } from './ai-service';
import { SettingsStore } from './settings-store';
import { PrivacyManager, type PrivacyWindow } from './privacy-manager';
import { collectGuardDiagnostics } from './companion-guard';
import { guardPolicyDenial, type GuardOperation } from '../shared/guard-policy';
import { initialToolbarBounds, restoreToolbarBounds, restoreWindowBounds } from './window-manager';

let mainWindow: BrowserWindow | null = null;
let overlayLabWindow: BrowserWindow | null = null;
let settingsStore: SettingsStore;
let shortcut = '';
const activeRequests = new Map<string, { controller: AbortController; sender: Electron.WebContents }>();
const activeTranscriptions = new Map<string, { controller: AbortController; sender: Electron.WebContents }>();
const aiProvider = new OpenAIProvider();
const transcriptionProvider = new OpenAITranscriptionProvider();
let privacyManager: PrivacyManager;
let guardSessionConsent = false;

function applyOverlayVisibility(window: PrivacyWindow, alwaysOnTop: boolean) {
  if (window.isDestroyed()) return;

  // Use the standard floating layer for ordinary windows.
  window.setAlwaysOnTop(alwaysOnTop, 'floating');

  // macOS requires the explicit option to keep pinned windows visible in fullscreen Spaces.
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: alwaysOnTop });
  } else if (process.platform === 'linux') {
    window.setVisibleOnAllWorkspaces(alwaysOnTop);
  }
}

function applyPinToOpenWindows(alwaysOnTop: boolean) {
  if (mainWindow && !mainWindow.isDestroyed()) applyOverlayVisibility(mainWindow, alwaysOnTop);
  if (overlayLabWindow && !overlayLabWindow.isDestroyed()) applyOverlayVisibility(overlayLabWindow, alwaysOnTop);
}

function createWindow() {
  const workAreas = screen.getAllDisplays().map(display => display.workArea);
  const savedBounds = settingsStore.getBounds();
  const savedToolbarBounds = savedBounds && savedBounds.height <= 140 && savedBounds.height >= 100 && savedBounds.width >= 520 ? savedBounds : undefined;
  const bounds = savedToolbarBounds
    ? restoreToolbarBounds(savedToolbarBounds, workAreas)
    : initialToolbarBounds(workAreas);
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 100,
    title: 'Interview Companion',
    alwaysOnTop: settingsStore.snapshot().settings.alwaysOnTop,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyOverlayVisibility(mainWindow, settingsStore.snapshot().settings.alwaysOnTop);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const load = process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  void load.catch(error => console.error('Could not load renderer:', error));

  let saveTimeout: NodeJS.Timeout | undefined;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isMinimized() || mainWindow.isMaximized() || privacyManager?.isActive()) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (!mainWindow) return;
      const { x, y, width, height } = mainWindow.getBounds();
      void settingsStore.saveBounds({ x, y, width, height }).catch(error => console.error('Could not save window position:', error));
    }, 250);
  };
  mainWindow.on('move', saveBounds);
  mainWindow.on('resize', saveBounds);
  mainWindow.on('closed', () => { clearTimeout(saveTimeout); mainWindow = null; });
}

function registerShortcut(nextShortcut: string) {
  if (shortcut) globalShortcut.unregister(shortcut);
  shortcut = '';
  if (!nextShortcut) return;
  if (globalShortcut.register(nextShortcut, () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else if (privacyManager?.isActive()) showPrivacyPrompt();
    else { mainWindow.show(); mainWindow.focus(); }
  })) shortcut = nextShortcut;
  else console.warn(`Could not register keyboard shortcut "${nextShortcut}". It may be in use by another application.`);
}

function showPrivacyPrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const width = Math.min(560, area.width);
  const height = Math.min(500, area.height);
  mainWindow.setMinimumSize(Math.min(360, width), Math.min(320, height));
  mainWindow.setBounds({
    x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
  });
  mainWindow.show();
  mainWindow.focus();
}

function assertTrustedSender(sender: Electron.WebContents) {
  if (!mainWindow || sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender.');
}

function sendChatEvent(sender: Electron.WebContents, event: ChatEvent) {
  if (!sender.isDestroyed() && !privacyManager?.isActive()) sender.send('ai:chunk', event);
}

function assertPrivacyInactive() {
  if (privacyManager?.isActive()) throw new Error('Screen-Sharing Privacy Mode is active. Turn it off before starting AI or transcription.');
}

function assertGuardOperationAllowed(operation: GuardOperation) {
  const reason = guardPolicyDenial(
    settingsStore.snapshot().settings.guard,
    guardSessionConsent,
    privacyManager?.isActive() ?? false,
    operation,
  );
  if (reason) throw new Error(reason);
}

function cancelActiveWork() {
  for (const { controller } of activeRequests.values()) controller.abort();
  for (const { controller } of activeTranscriptions.values()) controller.abort();
}

function cancelAIRequests() {
  for (const { controller } of activeRequests.values()) controller.abort();
}

function cancelTranscriptions() {
  for (const { controller } of activeTranscriptions.values()) controller.abort();
}

function readableAIError(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  if (status === 401) return 'The API key was rejected. Check your saved credentials.';
  if (status === 429) return 'The AI provider rate limit was reached. Wait a moment and retry.';
  if (status >= 500) return 'The AI provider is temporarily unavailable. Please retry.';
  if (error instanceof Error && error.name === 'AbortError') return 'Generation stopped.';
  return 'Could not reach the AI provider. Check your network, endpoint, model, and API key.';
}

ipcMain.handle('settings:get', event => {
  assertTrustedSender(event.sender);
  return settingsStore.snapshot();
});

ipcMain.handle('settings:save', async (event, value: unknown) => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  if (!isSettingsInput(value)) throw new Error('Settings were invalid and were not saved.');
  const previousPolicy = settingsStore.snapshot().settings.guard;
  const snapshot = await settingsStore.save(value as SettingsInput);
  const restrictedModeEnabled = !previousPolicy.restrictedMode && snapshot.settings.guard.restrictedMode;
  if (restrictedModeEnabled || (previousPolicy.allowAiAssistance && !snapshot.settings.guard.allowAiAssistance)) cancelAIRequests();
  if (restrictedModeEnabled || (previousPolicy.allowTranscription && !snapshot.settings.guard.allowTranscription)) cancelTranscriptions();
  applyPinToOpenWindows(snapshot.settings.alwaysOnTop);
  registerShortcut(snapshot.settings.keyboardShortcut);
  return snapshot;
});

ipcMain.handle('ai:stream', async (event, value: unknown) => {
  assertTrustedSender(event.sender);
  assertGuardOperationAllowed('ai');
  if (!isChatRequest(value)) throw new Error('The chat request was invalid.');
  const request = value as ChatRequest;
  if (activeRequests.has(request.requestId)) throw new Error('A request with this ID is already running.');
  const apiKey = settingsStore.apiKey();
  if (!apiKey) throw new Error('Add an OpenAI API key in Settings before sending a request.');
  const controller = new AbortController();
  activeRequests.set(request.requestId, { controller, sender: event.sender });
  const context = request.messages.slice(-(request.settings.historyLimit + 1));
  try {
    await aiProvider.stream(context, request.settings, apiKey, controller.signal, delta => {
      if (!controller.signal.aborted) sendChatEvent(event.sender, { requestId: request.requestId, delta });
    });
    if (!controller.signal.aborted) sendChatEvent(event.sender, { requestId: request.requestId, done: true });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('AI streaming request failed:', error);
      sendChatEvent(event.sender, { requestId: request.requestId, done: true, error: readableAIError(error) });
    }
  } finally {
    activeRequests.delete(request.requestId);
  }
});

ipcMain.handle('ai:cancel', (event, requestId: unknown) => {
  assertTrustedSender(event.sender);
  if (typeof requestId !== 'string' || requestId.length > 80) throw new Error('The cancellation request was invalid.');
  const request = activeRequests.get(requestId);
  if (request?.sender === event.sender) request.controller.abort();
});

ipcMain.handle('voice:transcribe', async (event, value: unknown) => {
  assertTrustedSender(event.sender);
  assertGuardOperationAllowed('transcription');
  if (!isTranscriptRequest(value)) throw new Error('The audio recording is invalid or too large.');
  const request = value as TranscriptRequest;
  if (activeTranscriptions.has(request.requestId)) throw new Error('A transcription with this ID is already running.');
  const apiKey = settingsStore.apiKey();
  if (!apiKey) throw new Error('Add an OpenAI API key in Settings before transcribing audio.');
  const controller = new AbortController();
  activeTranscriptions.set(request.requestId, { controller, sender: event.sender });
  try {
    return await transcriptionProvider.transcribe(request.audioBase64, request.mimeType, apiKey, settingsStore.snapshot().settings.apiEndpoint, controller.signal);
  } catch (error) {
    console.error('Audio transcription failed:', error);
    if (error && typeof error === 'object' && 'status' in error && Number(error.status) === 429) {
      throw new Error('The speech provider rate limit was reached. Please try again later.');
    }
    throw new Error('Transcription failed. Check your network, API key, audio format, and provider access.');
  } finally {
    activeTranscriptions.delete(request.requestId);
  }
});

ipcMain.handle('window:minimize', event => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  mainWindow?.minimize();
});
ipcMain.handle('window:close', event => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  mainWindow?.close();
});
ipcMain.handle('window:set-always-on-top', (event, value: unknown) => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  if (typeof value !== 'boolean') throw new Error('Pin setting must be a boolean.');
  return settingsStore.save({ settings: { ...settingsStore.snapshot().settings, alwaysOnTop: value } }).then(snapshot => {
    applyPinToOpenWindows(snapshot.settings.alwaysOnTop);
    return snapshot.settings.alwaysOnTop;
  });
});
ipcMain.handle('window:set-mode', (event, value: unknown) => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  if (value !== 'toolbar' && value !== 'expanded' && value !== 'answer') throw new Error('Window mode was invalid.');
  if (!mainWindow) return;
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const width = value === 'toolbar' ? Math.min(920, workArea.width) : value === 'answer' ? Math.min(760, workArea.width) : Math.min(460, workArea.width);
  const height = value === 'toolbar' ? Math.min(120, workArea.height) : value === 'answer' ? Math.min(620, workArea.height) : Math.min(740, workArea.height);
  const minWidth = Math.min(value === 'toolbar' ? 520 : value === 'answer' ? 560 : 360, width);
  const minHeight = Math.min(value === 'toolbar' ? 100 : 480, height);
  mainWindow.setMinimumSize(minWidth, minHeight);
  const x = workArea.x + Math.max(0, Math.round((workArea.width - width) / 2));
  const y = value === 'toolbar'
    ? workArea.y + Math.min(42, Math.max(0, workArea.height - height))
    : workArea.y + Math.max(0, Math.round((workArea.height - height) / 2));
  mainWindow.setBounds({ x, y, width, height });
});

ipcMain.handle('lab:open', event => {
  assertTrustedSender(event.sender);
  assertPrivacyInactive();
  if (overlayLabWindow && !overlayLabWindow.isDestroyed()) {
    overlayLabWindow.show();
    overlayLabWindow.focus();
    return;
  }
  overlayLabWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 620,
    minHeight: 480,
    title: 'Interview Companion — Local Overlay Lab',
    alwaysOnTop: settingsStore.snapshot().settings.alwaysOnTop,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyOverlayVisibility(overlayLabWindow, settingsStore.snapshot().settings.alwaysOnTop);
  overlayLabWindow.on('closed', () => { overlayLabWindow = null; });
  overlayLabWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayLabWindow.webContents.on('will-navigate', navigationEvent => navigationEvent.preventDefault());
  const labHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Overlay Lab</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#17243b;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{max-width:820px;margin:0 auto;padding:32px 24px}header,.card{background:#fff;border:1px solid #d8e0ec;border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 8px 24px #14233a0c}header{border-top:5px solid #0b8a82}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 10px}p{margin:8px 0;color:#526078}.tag{display:inline-block;padding:4px 8px;border-radius:20px;background:#e5f7f4;color:#076b64;font-size:12px;font-weight:700}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}button{border:0;border-radius:9px;background:#087c72;color:white;padding:10px 14px;font-weight:700;cursor:pointer}button.secondary{background:#e8eef6;color:#20304a}dl{display:grid;grid-template-columns:180px 1fr;gap:8px;margin:0}dt{color:#61708a}dd{margin:0;font-weight:650}#surface:fullscreen{background:#10203a;color:#fff;padding:10vh 8vw}#surface:fullscreen p{color:#d2dcef}.warning{padding:12px;border-left:3px solid #e6ad44;background:#fff8e8;border-radius:6px}@media(max-width:560px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}}
</style></head><body><main id="surface" class="wrap">
<header><span class="tag">LOCAL TEST WINDOW · NO NETWORK</span><h1>Overlay behavior lab</h1><p>This synthetic page belongs to Interview Companion. Use it to observe normal window focus and fullscreen behavior on your own desktop.</p></header>
<section class="card"><h2>Window state</h2><dl><dt>Page visibility</dt><dd id="visibility">—</dd><dt>Document focus</dt><dd id="focus">—</dd><dt>Fullscreen element</dt><dd id="fullscreen">None</dd></dl><div class="actions"><button id="fullscreenButton">Enter content fullscreen</button><button class="secondary" id="focusButton">Focus this test window</button></div></section>
<section class="card"><h2>What to observe</h2><p>With the companion pinned, click the test window and switch between ordinary windows. Note which window appears in front. Then try content fullscreen and observe whether the companion remains visible.</p><p class="warning">Fullscreen and workspace behavior depend on the OS and desktop environment. The test does not inspect other apps or interact with browser pages.</p></section>
<section class="card"><h2>Layer boundaries</h2><p><b>Browser renderer:</b> this page can report its own focus, visibility, and fullscreen state. It cannot reliably inspect unrelated desktop windows.</p><p><b>OS window API:</b> Electron requests ordinary always-on-top and workspace behavior for the companion.</p><p><b>Display composition:</b> fullscreen and secure display rules are ultimately controlled by the operating system.</p></section>
</main><script>
const visibility=document.querySelector('#visibility'),focus=document.querySelector('#focus'),fullscreen=document.querySelector('#fullscreen'),surface=document.querySelector('#surface'),button=document.querySelector('#fullscreenButton');function update(){visibility.textContent=document.visibilityState;focus.textContent=document.hasFocus()?'Focused':'Not focused';fullscreen.textContent=document.fullscreenElement?'Active':'None';button.textContent=document.fullscreenElement?'Exit content fullscreen':'Enter content fullscreen'}document.addEventListener('visibilitychange',update);window.addEventListener('focus',update);window.addEventListener('blur',update);document.addEventListener('fullscreenchange',update);button.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await surface.requestFullscreen()}catch{alert('Fullscreen was not available in this environment.')}});document.querySelector('#focusButton').addEventListener('click',()=>window.focus());update();
</script></body></html>`;
  void overlayLabWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(labHtml)}`);
});

ipcMain.handle('privacy:get-status', event => {
  assertTrustedSender(event.sender);
  return privacyManager.status();
});
ipcMain.handle('privacy:enable', async event => {
  assertTrustedSender(event.sender);
  return privacyManager.enable();
});
ipcMain.handle('privacy:disable', async event => {
  assertTrustedSender(event.sender);
  return privacyManager.disable(async () => {
    const options = {
      type: 'warning',
      title: 'Leave Screen-Sharing Privacy Mode?',
      message: 'Restore the Interview Companion interface?',
      detail: 'The microphone will remain stopped. You must start it again yourself.',
      buttons: ['Keep Privacy Mode', 'Restore Interface'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    } satisfies Electron.MessageBoxOptions;
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  });
});
ipcMain.handle('privacy:hide-prompt', event => {
  assertTrustedSender(event.sender);
  privacyManager.hidePrivacyPrompt();
});

ipcMain.handle('guard:get-diagnostics', (event): GuardDiagnostics => {
  assertTrustedSender(event.sender);
  const currentWindow = mainWindow && !mainWindow.isDestroyed()
    ? { visible: mainWindow.isVisible(), alwaysOnTop: mainWindow.isAlwaysOnTop() }
    : null;
  return collectGuardDiagnostics({
    platform: process.platform,
    getMediaAccessStatus: type => systemPreferences.getMediaAccessStatus(type),
    window: currentWindow,
    sessionConsent: guardSessionConsent,
  });
});
ipcMain.handle('guard:confirm-session', (event, confirmed: unknown) => {
  assertTrustedSender(event.sender);
  if (confirmed !== true) throw new Error('Session consent must be explicitly confirmed.');
  guardSessionConsent = true;
  event.sender.send('guard:consent-changed', true);
  return true;
});
ipcMain.handle('guard:revoke-session', event => {
  assertTrustedSender(event.sender);
  guardSessionConsent = false;
  cancelActiveWork();
  event.sender.send('guard:consent-changed', false);
  return true;
});

dotenv.config({ path: resolve(process.cwd(), '.env') });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const audioOnly = permission === 'media' && mediaTypes?.includes('audio') && !mediaTypes.includes('video');
    const policy = settingsStore?.snapshot().settings.guard;
    const microphoneAllowed = policy
      && !guardPolicyDenial(policy, guardSessionConsent, privacyManager?.isActive() ?? false, 'microphone');
    callback(webContents === mainWindow?.webContents && Boolean(audioOnly) && microphoneAllowed);
  });
  settingsStore = new SettingsStore(app.getPath('userData'), safeStorage);
  await settingsStore.load();
  privacyManager = new PrivacyManager({
    getMainWindow: () => mainWindow,
    getAuxiliaryWindow: () => overlayLabWindow,
    getAlwaysOnTop: () => settingsStore.snapshot().settings.alwaysOnTop,
    restoreAlwaysOnTopPreference: async value => {
      const snapshot = await settingsStore.save({ settings: { ...settingsStore.snapshot().settings, alwaysOnTop: value } });
      applyPinToOpenWindows(snapshot.settings.alwaysOnTop);
    },
    applyAlwaysOnTop: (window, value) => applyOverlayVisibility(window, value),
    cancelRequests: cancelActiveWork,
    onStatusChange: status => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('privacy:changed', status);
      mainWindow.webContents.send('privacy:share-safe-mode', status.active);
    },
  });
  createWindow();
  registerShortcut(settingsStore.snapshot().settings.keyboardShortcut);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  console.error('Application startup failed:', error);
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const { controller } of activeRequests.values()) controller.abort();
  for (const { controller } of activeTranscriptions.values()) controller.abort();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, screen, session, shell } from 'electron';
import { resolve, join } from 'node:path';
import dotenv from 'dotenv';
import type { ChatEvent, ChatRequest, SettingsInput, TranscriptRequest } from '../shared/contracts';
import { isChatRequest, isSettingsInput, isTranscriptRequest } from '../shared/settings';
import { OpenAIProvider, OpenAITranscriptionProvider } from './ai-service';
import { SettingsStore } from './settings-store';
import { initialToolbarBounds, restoreWindowBounds } from './window-manager';

let mainWindow: BrowserWindow | null = null;
let settingsStore: SettingsStore;
let shortcut = '';
const activeRequests = new Map<string, { controller: AbortController; sender: Electron.WebContents }>();
const aiProvider = new OpenAIProvider();
const transcriptionProvider = new OpenAITranscriptionProvider();

function createWindow() {
  const workAreas = screen.getAllDisplays().map(display => display.workArea);
  const savedBounds = settingsStore.getBounds();
  const savedToolbarBounds = savedBounds && savedBounds.height <= 240 && savedBounds.width >= 520 ? savedBounds : undefined;
  const bounds = savedToolbarBounds
    ? restoreWindowBounds(savedToolbarBounds, workAreas)
    : initialToolbarBounds(workAreas);
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 140,
    title: 'Interview Companion',
    alwaysOnTop: settingsStore.snapshot().settings.alwaysOnTop,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (settingsStore.snapshot().settings.alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'floating');
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
    if (!mainWindow || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
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
    else { mainWindow.show(); mainWindow.focus(); }
  })) shortcut = nextShortcut;
  else console.warn(`Could not register keyboard shortcut "${nextShortcut}". It may be in use by another application.`);
}

function assertTrustedSender(sender: Electron.WebContents) {
  if (!mainWindow || sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender.');
}

function sendChatEvent(sender: Electron.WebContents, event: ChatEvent) {
  if (!sender.isDestroyed()) sender.send('ai:chunk', event);
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
  if (!isSettingsInput(value)) throw new Error('Settings were invalid and were not saved.');
  const snapshot = await settingsStore.save(value as SettingsInput);
  if (mainWindow) mainWindow.setAlwaysOnTop(snapshot.settings.alwaysOnTop, 'floating');
  registerShortcut(snapshot.settings.keyboardShortcut);
  return snapshot;
});

ipcMain.handle('ai:stream', async (event, value: unknown) => {
  assertTrustedSender(event.sender);
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
      sendChatEvent(event.sender, { requestId: request.requestId, delta });
    });
    sendChatEvent(event.sender, { requestId: request.requestId, done: true });
  } catch (error) {
    if (controller.signal.aborted) {
      sendChatEvent(event.sender, { requestId: request.requestId, done: true, cancelled: true });
    } else {
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
  if (!isTranscriptRequest(value)) throw new Error('The audio recording is invalid or too large.');
  const request = value as TranscriptRequest;
  const apiKey = settingsStore.apiKey();
  if (!apiKey) throw new Error('Add an OpenAI API key in Settings before transcribing audio.');
  try {
    return await transcriptionProvider.transcribe(request.audioBase64, request.mimeType, apiKey, settingsStore.snapshot().settings.apiEndpoint);
  } catch (error) {
    console.error('Audio transcription failed:', error);
    if (error && typeof error === 'object' && 'status' in error && Number(error.status) === 429) {
      throw new Error('The speech provider rate limit was reached. Please try again later.');
    }
    throw new Error('Transcription failed. Check your network, API key, audio format, and provider access.');
  }
});

ipcMain.handle('window:minimize', event => {
  assertTrustedSender(event.sender);
  mainWindow?.minimize();
});
ipcMain.handle('window:close', event => {
  assertTrustedSender(event.sender);
  mainWindow?.close();
});
ipcMain.handle('window:set-always-on-top', (event, value: unknown) => {
  assertTrustedSender(event.sender);
  if (typeof value !== 'boolean') throw new Error('Pin setting must be a boolean.');
  mainWindow?.setAlwaysOnTop(value, 'floating');
  return value;
});
ipcMain.handle('window:set-mode', (event, value: unknown) => {
  assertTrustedSender(event.sender);
  if (value !== 'toolbar' && value !== 'expanded') throw new Error('Window mode must be toolbar or expanded.');
  if (!mainWindow) return;
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const width = value === 'toolbar' ? Math.min(780, workArea.width) : Math.min(460, workArea.width);
  const height = value === 'toolbar' ? Math.min(156, workArea.height) : Math.min(740, workArea.height);
  const minWidth = Math.min(value === 'toolbar' ? 520 : 360, width);
  const minHeight = Math.min(value === 'toolbar' ? 140 : 480, height);
  mainWindow.setMinimumSize(minWidth, minHeight);
  const x = workArea.x + Math.max(0, Math.round((workArea.width - width) / 2));
  const y = value === 'toolbar'
    ? workArea.y + Math.min(42, Math.max(0, workArea.height - height))
    : workArea.y + Math.max(0, Math.round((workArea.height - height) / 2));
  mainWindow.setBounds({ x, y, width, height });
});

dotenv.config({ path: resolve(process.cwd(), '.env') });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const audioOnly = permission === 'media' && mediaTypes?.includes('audio') && !mediaTypes.includes('video');
    callback(webContents === mainWindow?.webContents && Boolean(audioOnly));
  });
  settingsStore = new SettingsStore(app.getPath('userData'), safeStorage);
  await settingsStore.load();
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

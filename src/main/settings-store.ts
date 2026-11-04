import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettings, SettingsInput, SettingsSnapshot, WindowBounds } from '../shared/contracts';
import { DEFAULT_SETTINGS, normalizeStoredSettings } from '../shared/settings';

type SecureStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

type StoredData = {
  formatVersion: 1;
  settings: AppSettings;
  encryptedApiKey?: string;
  bounds?: WindowBounds;
};

export class SettingsStore {
  private data: StoredData;
  private readonly filePath: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, private readonly secureStorage: SecureStorage) {
    this.filePath = join(userDataPath, 'settings.json');
    this.data = { formatVersion: 1, settings: { ...DEFAULT_SETTINGS, model: process.env.OPENAI_MODEL?.trim() || DEFAULT_SETTINGS.model } };
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('Settings file has an invalid format.');
      const stored = parsed as Record<string, unknown>;
      const savedSettings = normalizeStoredSettings(stored.settings) ?? DEFAULT_SETTINGS;
      const settings = stored.formatVersion === 1
        ? savedSettings
        : { ...savedSettings, alwaysOnTop: true };
      this.data = {
        formatVersion: 1,
        settings,
        ...(typeof stored.encryptedApiKey === 'string' ? { encryptedApiKey: stored.encryptedApiKey } : {}),
        ...(isWindowBounds(stored.bounds) ? { bounds: stored.bounds } : {}),
      };
      if (!normalizeStoredSettings(stored.settings)) console.error('Saved settings were invalid; defaults are in use.');
      if (stored.formatVersion !== 1) await this.persist(this.data);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      console.error('Could not load saved settings:', error);
    }
  }

  snapshot(): SettingsSnapshot {
    return { settings: this.data.settings, hasApiKey: Boolean(this.data.encryptedApiKey || process.env.OPENAI_API_KEY) };
  }

  apiKey(): string {
    if (!this.data.encryptedApiKey) return process.env.OPENAI_API_KEY ?? '';
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable. Re-enter your API key after restarting the app.');
    }
    return this.secureStorage.decryptString(Buffer.from(this.data.encryptedApiKey, 'base64'));
  }

  getBounds(): WindowBounds | undefined {
    return this.data.bounds;
  }

  async save(input: SettingsInput): Promise<SettingsSnapshot> {
    const next: StoredData = { ...this.data, settings: input.settings };
    if (input.clearApiKey) next.encryptedApiKey = undefined;
    if (input.apiKey?.trim()) {
      if (!this.secureStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is unavailable; the API key was not saved.');
      }
      next.encryptedApiKey = this.secureStorage.encryptString(input.apiKey.trim()).toString('base64');
    }
    await this.persist(next);
    this.data = next;
    return this.snapshot();
  }

  async saveBounds(bounds: WindowBounds): Promise<void> {
    const next = { ...this.data, bounds };
    await this.persist(next);
    this.data = next;
  }

  private persist(data: StoredData): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    const operation = this.persistQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, serialized, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.persistQueue = operation.catch(error => {
      console.error('Could not write saved settings:', error);
    });
    return operation;
  }
}

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

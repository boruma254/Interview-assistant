import type { PrivacyStatus, WindowBounds } from '../shared/contracts';

export interface PrivacyWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isAlwaysOnTop(): boolean;
  getBounds(): WindowBounds;
  getMinimumSize(): number[];
  setBounds(bounds: WindowBounds): void;
  setMinimumSize(width: number, height: number): void;
  setAlwaysOnTop(flag: boolean, level?: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  hide(): void;
  show(): void;
  focus(): void;
  minimize(): void;
  maximize(): void;
  setFullScreen(flag: boolean): void;
}

type SavedWindowState = {
  bounds: WindowBounds;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  fullScreen: boolean;
  alwaysOnTop: boolean;
  minimumSize: [number, number];
};

type SavedState = {
  main?: SavedWindowState;
  auxiliary?: SavedWindowState;
  alwaysOnTop: boolean;
};

type PrivacyManagerOptions = {
  getMainWindow: () => PrivacyWindow | null;
  getAuxiliaryWindow: () => PrivacyWindow | null;
  getAlwaysOnTop: () => boolean;
  restoreAlwaysOnTopPreference: (value: boolean) => Promise<void>;
  applyAlwaysOnTop: (window: PrivacyWindow, value: boolean) => void;
  cancelRequests: () => void;
  onStatusChange: (status: PrivacyStatus) => void;
};

export class PrivacyManager {
  private active = false;
  private savedState: SavedState | null = null;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PrivacyManagerOptions) {}

  status(): PrivacyStatus {
    return {
      active: this.active,
      alwaysOnTop: this.savedState?.alwaysOnTop ?? this.options.getAlwaysOnTop(),
    };
  }

  isActive(): boolean {
    return this.active;
  }

  enable(): Promise<PrivacyStatus> {
    return this.serialize(async () => {
      if (this.active) return this.status();
      const state: SavedState = {
        main: this.capture(this.options.getMainWindow()),
        auxiliary: this.capture(this.options.getAuxiliaryWindow()),
        alwaysOnTop: this.options.getAlwaysOnTop(),
      };
      this.savedState = state;
      this.active = true;
      try {
        this.options.cancelRequests();
        this.hide(this.options.getAuxiliaryWindow());
        this.hide(this.options.getMainWindow());
        this.publish();
        return this.status();
      } catch (error) {
        this.active = false;
        this.restoreWindow(this.options.getAuxiliaryWindow(), state.auxiliary);
        this.restoreWindow(this.options.getMainWindow(), state.main);
        this.savedState = null;
        this.publish();
        throw error;
      }
    });
  }

  disable(confirmRestore: () => Promise<boolean>): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.active || !await confirmRestore()) return false;
      const state = this.savedState;
      if (!state) throw new Error('Privacy mode window state is unavailable.');
      const main = this.options.getMainWindow();
      const auxiliary = this.options.getAuxiliaryWindow();
      try {
        this.active = false;
        await this.options.restoreAlwaysOnTopPreference(state.alwaysOnTop);
        this.restoreWindow(auxiliary, state.auxiliary);
        this.restoreWindow(main, state.main);
        this.savedState = null;
        this.publish();
        return true;
      } catch (error) {
        this.active = true;
        this.hide(auxiliary);
        this.hide(main);
        this.publish();
        throw error;
      }
    });
  }

  hidePrivacyPrompt(): void {
    if (this.active) this.hide(this.options.getMainWindow());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }

  private capture(window: PrivacyWindow | null): SavedWindowState | undefined {
    if (!window || window.isDestroyed()) return undefined;
    const [minimumWidth = 0, minimumHeight = 0] = window.getMinimumSize();
    return {
      bounds: window.getBounds(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
      alwaysOnTop: window.isAlwaysOnTop(),
      minimumSize: [minimumWidth, minimumHeight],
    };
  }

  private hide(window: PrivacyWindow | null): void {
    if (window && !window.isDestroyed()) window.hide();
  }

  private restoreWindow(window: PrivacyWindow | null, saved: SavedWindowState | undefined): void {
    if (!window || window.isDestroyed() || !saved) return;
    this.options.applyAlwaysOnTop(window, saved.alwaysOnTop);
    window.setMinimumSize(...saved.minimumSize);
    window.setBounds(saved.bounds);
    if (!saved.visible) {
      window.hide();
      return;
    }
    if (saved.minimized) {
      window.show();
      window.minimize();
      return;
    }
    if (saved.fullScreen) window.setFullScreen(true);
    else if (saved.maximized) window.maximize();
    else window.show();
    window.focus();
  }

  private publish(): void {
    this.options.onStatusChange(this.status());
  }
}

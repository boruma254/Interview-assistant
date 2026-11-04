import { describe, expect, it, vi } from 'vitest';
import type { WindowBounds } from '../src/shared/contracts';
import { PrivacyManager, type PrivacyWindow } from '../src/main/privacy-manager';

class MockWindow implements PrivacyWindow {
  visible = true;
  minimized = false;
  maximized = false;
  fullScreen = false;
  destroyed = false;
  alwaysOnTop = true;
  visibleOnAllWorkspaces = true;
  bounds: WindowBounds = { x: 20, y: 30, width: 900, height: 120 };
  minimumSize: [number, number] = [520, 100];
  hide = vi.fn(() => { this.visible = false; });
  show = vi.fn(() => { this.visible = true; this.minimized = false; });
  focus = vi.fn();
  minimize = vi.fn(() => { this.minimized = true; });
  maximize = vi.fn(() => { this.maximized = true; });
  setFullScreen = vi.fn((value: boolean) => { this.fullScreen = value; });
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  isAlwaysOnTop() { return this.alwaysOnTop; }
  getBounds() { return this.bounds; }
  getMinimumSize() { return this.minimumSize; }
  setBounds(bounds: WindowBounds) { this.bounds = bounds; }
  setMinimumSize(width: number, height: number) { this.minimumSize = [width, height]; }
  setAlwaysOnTop(value: boolean) { this.alwaysOnTop = value; }
  setVisibleOnAllWorkspaces(value: boolean) { this.visibleOnAllWorkspaces = value; }
}

function setupManager(main = new MockWindow(), auxiliary = new MockWindow()) {
  let alwaysOnTop = true;
  const onStatusChange = vi.fn();
  const cancelRequests = vi.fn();
  const manager = new PrivacyManager({
    getMainWindow: () => main,
    getAuxiliaryWindow: () => auxiliary,
    getAlwaysOnTop: () => alwaysOnTop,
    restoreAlwaysOnTopPreference: async value => { alwaysOnTop = value; },
    applyAlwaysOnTop: (window, value) => window.setAlwaysOnTop(value, 'floating'),
    cancelRequests,
    onStatusChange,
  });
  return { manager, main, auxiliary, cancelRequests, onStatusChange, setAlwaysOnTop: (value: boolean) => { alwaysOnTop = value; } };
}

describe('PrivacyManager', () => {
  it('hides all companion windows, cancels work, and publishes active status', async () => {
    const { manager, main, auxiliary, cancelRequests, onStatusChange } = setupManager();
    const status = await manager.enable();
    expect(status.active).toBe(true);
    expect(main.hide).toHaveBeenCalledOnce();
    expect(auxiliary.hide).toHaveBeenCalledOnce();
    expect(cancelRequests).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenLastCalledWith({ active: true, alwaysOnTop: true });
  });

  it('requires confirmation and restores bounds, visibility, and the saved pin preference', async () => {
    const main = new MockWindow();
    const auxiliary = new MockWindow();
    auxiliary.visible = false;
    main.bounds = { x: 100, y: 70, width: 700, height: 600 };
    const { manager, setAlwaysOnTop } = setupManager(main, auxiliary);
    await manager.enable();
    setAlwaysOnTop(false);
    main.alwaysOnTop = false;
    expect(await manager.disable(async () => false)).toBe(false);
    expect(manager.isActive()).toBe(true);
    expect(main.visible).toBe(false);
    expect(await manager.disable(async () => true)).toBe(true);
    expect(manager.isActive()).toBe(false);
    expect(main.bounds).toEqual({ x: 100, y: 70, width: 700, height: 600 });
    expect(main.alwaysOnTop).toBe(true);
    expect(main.visible).toBe(true);
    expect(auxiliary.visible).toBe(false);
  });

  it('serializes repeated enable requests without duplicate cancellation', async () => {
    const { manager, cancelRequests, main } = setupManager();
    await Promise.all([manager.enable(), manager.enable(), manager.enable()]);
    expect(cancelRequests).toHaveBeenCalledOnce();
    expect(main.hide).toHaveBeenCalledOnce();
  });

  it('skips destroyed windows and restores after a failed enable', async () => {
    const main = new MockWindow();
    const auxiliary = new MockWindow();
    auxiliary.destroyed = true;
    const { manager, cancelRequests } = setupManager(main, auxiliary);
    const status = await manager.enable();
    expect(status.active).toBe(true);
    expect(cancelRequests).toHaveBeenCalledOnce();
    expect(auxiliary.hide).not.toHaveBeenCalled();

    const failing = new MockWindow();
    failing.hide = vi.fn(() => { throw new Error('hide failed'); });
    const setup = setupManager(failing, new MockWindow());
    await expect(setup.manager.enable()).rejects.toThrow('hide failed');
    expect(setup.manager.isActive()).toBe(false);
    expect(failing.visible).toBe(true);
  });

  it('hides the privacy status window only while privacy mode is active', async () => {
    const { manager, main } = setupManager();
    manager.hidePrivacyPrompt();
    expect(main.hide).not.toHaveBeenCalled();
    await manager.enable();
    manager.hidePrivacyPrompt();
    expect(main.hide).toHaveBeenCalledTimes(2);
  });
});

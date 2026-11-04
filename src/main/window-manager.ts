import type { WindowBounds } from '../shared/contracts';

type WorkArea = { x: number; y: number; width: number; height: number };

export function initialToolbarBounds(workAreas: WorkArea[]): WindowBounds {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  const width = Math.min(920, primary.width);
  const height = Math.min(120, primary.height);
  return {
    x: primary.x + Math.max(0, Math.round((primary.width - width) / 2)),
    y: primary.y + Math.min(42, Math.max(0, primary.height - height)),
    width,
    height,
  };
}

export function restoreToolbarBounds(saved: WindowBounds | undefined, workAreas: WorkArea[]): WindowBounds {
  const fallback = initialToolbarBounds(workAreas);
  if (!saved || saved.width < 520 || saved.height < 100 || saved.height > 140) return fallback;
  const visible = workAreas.some(area =>
    saved.x + Math.min(saved.width, 100) > area.x
    && saved.x < area.x + area.width
    && saved.y + Math.min(saved.height, 60) > area.y
    && saved.y < area.y + area.height,
  );
  return visible ? { ...saved, width: Math.min(saved.width, fallback.width), height: Math.min(saved.height, fallback.height) } : fallback;
}

export function restoreWindowBounds(saved: WindowBounds | undefined, workAreas: WorkArea[]): WindowBounds {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  const fallback = {
    x: primary.x + Math.max(0, Math.round((primary.width - 440) / 2)),
    y: primary.y + Math.max(0, Math.round((primary.height - 700) / 2)),
    width: 440,
    height: 700,
  };
  if (!saved || saved.width < 360 || saved.height < 480 || saved.width > 2400 || saved.height > 1800) return fallback;
  const visible = workAreas.some(area =>
    saved.x + Math.min(saved.width, 100) > area.x
    && saved.x < area.x + area.width
    && saved.y + Math.min(saved.height, 100) > area.y
    && saved.y < area.y + area.height,
  );
  return visible ? saved : fallback;
}

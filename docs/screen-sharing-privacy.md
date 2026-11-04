# Screen-Sharing Privacy Mode

## Behavior

Screen-Sharing Privacy Mode is an explicit pause state, not a capture filter. Enabling it:

- Stops the renderer's `MediaRecorder` and every microphone media track, discarding the in-progress recording.
- Aborts active AI and transcription requests and blocks new ones in the Electron main process.
- Hides both the companion and its local overlay-lab window.
- Keeps only privacy status available if the user reopens the app with the configured global shortcut.
- Leaves the Always-on-Top preference unchanged.

To leave privacy mode, use the configured shortcut, then choose **Restore interface…** and confirm in the native dialog. The app remains on a privacy-only screen until confirmed. The microphone is not restarted. **Keep hidden** hides that status screen again.

Privacy mode is in-memory and starts disabled after an application restart. This avoids leaving the app unexpectedly hidden after a crash or restart. Always-on-Top is stored in the existing settings file and defaults to on.

## Architecture

- `src/main/privacy-manager.ts` serializes privacy transitions, snapshots window visibility/bounds/minimized/maximized state and Always-on-Top, cancels work, hides both windows, and restores the snapshot after confirmation.
- `src/main/index.ts` owns the privacy manager, gates IPC requests, aborts AI/transcription controllers, applies platform-aware window ordering (including macOS fullscreen Spaces when Always-on-Top is enabled), and displays the native restore confirmation.
- The preload exposes `window.privacyControls` (`enterShareSafeMode`, `exitShareSafeMode`, `onModeChanged`) in addition to the existing `window.desktop` methods. Those controls invoke the same `privacy:enable` / `privacy:disable` handlers; they do not register a second main-process implementation.
- The renderer subscribes to `privacy:share-safe-mode` and stops the live `MediaStream` there. Leaving privacy mode keeps transcription paused until the user starts the microphone again.
- The existing `SettingsStore` persists Always-on-Top through its normal settings save path.

## Capture protection investigation

This application does **not** call Electron's `BrowserWindow.setContentProtection()`. Privacy Mode hides the app instead. Content protection is not a substitute for that explicit pause, and screen-capture exclusion is **not guaranteed**.

Electron documents `win.setContentProtection(enable)` for macOS and Windows as a request to prevent other apps from capturing the window. The request is forwarded to the operating system; capture apps, OS versions, and share sources can still include the window.

Source: [Electron `BrowserWindow.setContentProtection`](https://www.electronjs.org/docs/latest/api/browser-window).

### Windows

Electron calls `SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`.

- On Windows 10 version 2004 and later, the window can be removed from capture entirely when the capturer honors that affinity.
- On older Windows 10 builds the affinity behaves like `WDA_MONITOR`: capturers may see a black rectangle rather than the real pixels.
- The change takes effect on the next desktop composition, not when the call returns. A capture started immediately afterwards can still contain the window.
- In a Remote Desktop session, a Remote Desktop client can still show the window to the remote user, while software that captures the desktop may not. Chromium can disable `AllowWindowCaptureExclusionInRemoteSessions` if an app wants the opposite policy.

Windows 10 and Windows 11 should not be treated as identical: 11 uses Windows Graphics Capture more widely, but meeting apps can still choose DXGI desktop duplication, GDI, or their own pipelines.

### Windows Graphics Capture (WGC)

`WDA_EXCLUDEFROMCAPTURE` was added for WGC-style capture. A WGC session that respects window display affinity may omit the window or replace it. This project has not validated that Zoom, Teams, Meet, or the Windows Game Bar actually use WGC for a given share mode. Capturers that do not use WGC, or that composite a full framebuffer after exclusion fails, can still include the companion.

### macOS and ScreenCaptureKit

On macOS, Electron sets the `NSWindow` `sharingType` to `NSWindowSharingNone`. Electron documents an intentional platform change: newer Mac applications that use ScreenCaptureKit can capture the window even when `setContentProtection(true)` is set. ScreenCaptureKit is the capture path used by current macOS screen-sharing and many Chromium/Electron-based meeting clients. Do not treat `NSWindowSharingNone` as exclusion from Zoom, Meet, Teams, QuickTime, or the system screenshot UI.

### Share-source differences

These are expected differences, not measured results for this app:

| Share source | Why exclusion may not apply |
|---|---|
| Entire display / monitor | The capturer often copies the composed desktop. Exclusion, if honored, may punch a hole, draw black, or still include the window. |
| Individual application window | The window picker might hide, black out, or still list the companion. Behavior differs by OS and meeting app. |
| Browser tab | Tab capture usually records that browser's compositor, not this Electron window. Protecting Interview Companion does not change what a Chrome/Edge tab share sends. |

Meeting-app versions, GPU paths, and “share system audio / optimize for video” settings can change the pipeline without a visible UI difference. Always confirm with a second device or participant account.

## Practical verification checklist

Run these checks on actual devices. Use a second device or participant account to confirm what meeting participants receive. Do not infer capture results from the local preview alone.

### macOS

- [ ] Enable privacy mode while the toolbar is visible; confirm the companion and overlay-lab windows disappear.
- [ ] Confirm the macOS microphone indicator turns off after an active recording is stopped.
- [ ] Try the restore shortcut; confirm only the privacy status screen appears before confirmation.
- [ ] Cancel the native restore confirmation; confirm privacy remains active and the microphone remains off.
- [ ] Confirm **Keep hidden** hides the status screen again.
- [ ] Confirm restoration returns the prior window bounds and Always-on-Top setting without restarting recording.
- [ ] Repeat with the target meeting app and share mode, checking the participant view on a second account.

### Windows 10 and Windows 11

- [ ] Repeat the macOS lifecycle checks on Windows 10 and Windows 11 separately.
- [ ] Check the normal window z-order with Always-on-Top both on and off; disabling it must leave the app visible and usable.
- [ ] Confirm the saved Always-on-Top preference survives an application restart.
- [ ] Repeat with the target meeting app and share mode, checking the participant view on a second account.

### Meeting-app and share-source matrix

For each of Zoom, Google Meet, and Microsoft Teams, repeat with:

- [ ] Entire-display sharing.
- [ ] Individual-window sharing.
- [ ] Browser-tab sharing.
- [ ] Privacy mode enabled before sharing starts.
- [ ] Privacy mode enabled during an active recording, during transcription, and during a streamed AI response.
- [ ] Privacy mode left active after closing and restarting the application; it should start disabled, with the microphone still stopped.

Record the OS version, meeting-app version, selected source, and participant-side observation. Do not generalize one source or version's result to another.

## Known limits

- Windows does not provide the Electron all-workspaces API; ordinary Always-on-Top still works, but virtual-desktop behavior is OS controlled. Exclusive fullscreen and secure/system windows may still cover the companion.
- On macOS, Always-on-Top requests visibility across workspaces and fullscreen Spaces. The OS or an application’s fullscreen/security behavior can still limit where the companion appears.
- Linux is outside the packaged targets. Some Linux window managers, especially Wayland, may not honor Always-on-Top.
- Privacy Mode cannot stop a meeting application or the operating system from capturing other content. It only stops this app's capture/network work and hides this app's own windows.
- `setContentProtection()` is not used and would not guarantee exclusion, especially against ScreenCaptureKit on macOS and non-WGC capturers on Windows.
- If the app exits while privacy mode is active, its in-memory privacy flag is lost; no microphone session is resumed on restart.

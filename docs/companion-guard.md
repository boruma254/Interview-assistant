# Companion Guard

Companion Guard is an app-local diagnostics and policy page. It reports this app's own window state, queries Electron's documented media-access status where supported, and enforces session consent and usage policy in the Electron main process. It does not conceal the app from monitoring software, inspect other processes, capture the display, or claim that monitoring can be detected.

## What Guard reports

- **Window and display:** visibility and Always-on-Top are read from the companion's `BrowserWindow`. macOS screen-recording permission is queried with Electron `systemPreferences.getMediaAccessStatus('screen')`. Windows does not have an equivalent general screen-recording permission in this diagnostic and is reported as not applicable.
- **Capture activity:** activity from other screen-capture apps is always reported as unknown. An OS permission result is not proof that a capture is or is not in progress. The app can report its own microphone recorder state.
- **Microphone:** Electron's documented microphone access status is queried on macOS and Windows. Actual capture still requires a user action, session consent, policy permission, and the OS media permission handler. A live level meter is driven from the active app-owned microphone stream.
- **System audio:** system/loopback audio capture is not implemented. Guard reports this explicitly and the app captures microphone input only.
- **Device restrictions:** Guard reports a restricted media permission when Electron provides that signal. Otherwise, managed-device restrictions remain unknown; Guard does not inspect security processes or infer that the device is unmanaged.

Electron API references:

- [systemPreferences.getMediaAccessStatus](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesgetmediaaccessstatusmediatype)
- [Session permission request handler](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler)

## Consent and policy

Session consent is held in memory and resets on application restart. AI chat, microphone permission requests, and transcription are blocked in the main process until the user checks the consent statement in Companion Guard and confirms for the session. Users can revoke that consent; active AI and transcription requests are aborted, and microphone capture is stopped.

The saved Guard policy has independent controls for AI assistance, microphone recording, and transcription. Restricted mode blocks all three in the main process. Turning off microphone recording stops active capture; turning off transcription aborts active transcription and discards a recording when it is stopped. Audio recording and transcription never begin in the background. The existing OpenAI transcription provider is used only after an explicit transcribe/send action.

## Permissions

- **macOS microphone:** the user may need to allow Interview Companion under System Settings → Privacy & Security → Microphone. The packaged app includes `NSMicrophoneUsageDescription`.
- **macOS screen recording:** the OS may show a permission status in Guard. This app does not request screen capture. If another workflow needs it, manage access in System Settings → Privacy & Security → Screen & System Audio Recording.
- **Windows microphone:** the user may need to allow desktop apps under Settings → Privacy & security → Microphone. Windows global/device policy can still block access.
- **Windows screen recording:** Guard does not claim a general OS permission result; a sharing application may use different capture APIs and policies.
- **Network:** when explicitly submitted, chat text and chosen microphone recordings are sent to the configured OpenAI-compatible endpoint for AI processing or transcription.

## Validation checklist

Run `npm run typecheck`, `npm test`, and `npm run build` on each supported OS. The automated diagnostic tests simulate macOS and Windows permission results; they do not substitute for native checks.

On macOS and Windows separately:

1. Open Companion Guard, run diagnostics, and confirm the window state matches the actual companion window.
2. Verify screen permission is a real macOS Electron result or not applicable on Windows; confirm capture activity remains unknown.
3. Check microphone permission against the OS privacy settings. Start recording explicitly, speak, verify the level meter and active indicator, then stop and confirm the microphone indicator goes inactive.
4. Confirm system audio is reported as not implemented, not as detected or available.
5. Confirm that no AI or microphone request can start before session consent; revoke consent and verify requests stop.
6. Enable restricted mode; verify chat, microphone recording, and transcription are unavailable. Restart the app and confirm consent is required again.
7. Test permission denial/restriction, disconnected microphones, absent input-level support, and offline transcription errors.
8. Use the sharing application's participant-side preview to verify what is shared. Guard cannot determine capture behavior for all apps, modes, remote sessions, or OS versions.

## Limitations

Native OS permission status can be unavailable or stale and does not report capture activity. No general supported API used by this app can establish whether another application, remote session, or system service is capturing the display or audio. `setContentProtection()` is not used as a guarantee. Exclusive-fullscreen, secure desktops, administrative controls, meeting-app capture paths, and operating-system policies can override ordinary window or permission behavior.

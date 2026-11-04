import type { GuardDiagnostics, GuardPermissionCheck, GuardPermissionState } from '../shared/contracts';

type GuardPlatform = NodeJS.Platform;
type MediaAccessStatus = GuardPermissionState;

type GuardWindowState = {
  visible: boolean;
  alwaysOnTop: boolean;
};

type GuardDiagnosticsOptions = {
  platform: GuardPlatform;
  getMediaAccessStatus: (type: 'microphone' | 'screen') => MediaAccessStatus;
  window: GuardWindowState | null;
  sessionConsent: boolean;
};

function queryPermission(
  getMediaAccessStatus: GuardDiagnosticsOptions['getMediaAccessStatus'],
  type: 'microphone' | 'screen',
): GuardPermissionCheck {
  try {
    const state = getMediaAccessStatus(type);
    return {
      state,
      detail: state === 'granted'
        ? 'The operating system reports access granted. This does not indicate whether capture is currently occurring.'
        : state === 'denied'
          ? 'The operating system reports access denied. Review the app permission in system settings.'
          : state === 'restricted'
            ? 'The operating system reports access restricted. A system or device policy may prevent access.'
            : state === 'not-determined'
              ? 'The operating system has not yet recorded an access decision.'
              : 'The operating system did not provide a definitive permission result.',
    };
  } catch (error) {
    return {
      state: 'unknown',
      detail: `Could not query the operating-system permission: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

export function collectGuardDiagnostics(options: GuardDiagnosticsOptions): GuardDiagnostics {
  const supported = options.platform === 'darwin' || options.platform === 'win32';
  const platform = options.platform === 'darwin' ? 'macos' : options.platform === 'win32' ? 'windows' : 'unsupported';
  const microphonePermission = supported
    ? queryPermission(options.getMediaAccessStatus, 'microphone')
    : { state: 'unsupported' as const, detail: 'Microphone permission diagnostics are not supported on this operating system.' };
  const screenRecordingPermission = !supported
    ? { state: 'unsupported' as const, detail: 'Screen-recording permission diagnostics are not supported on this operating system.' }
    : options.platform === 'win32'
      ? { state: 'not-applicable' as const, detail: 'Windows does not expose a macOS-style screen-recording permission for desktop capture in this diagnostic.' }
      : queryPermission(options.getMediaAccessStatus, 'screen');

  const restrictionReported = microphonePermission.state === 'restricted'
    || screenRecordingPermission.state === 'restricted';

  return {
    checkedAt: new Date().toISOString(),
    platform,
    sessionConsent: options.sessionConsent,
    window: options.window ?? { visible: null, alwaysOnTop: null },
    display: {
      screenRecordingPermission,
      captureActivity: {
        state: 'unknown',
        detail: 'The app cannot reliably detect whether another app or service is capturing the display. Permission status is not capture activity.',
      },
    },
    audio: {
      microphonePermission,
      systemAudioCapture: {
        state: 'unsupported',
        detail: 'This app does not capture system audio. Only user-started microphone recording is implemented.',
      },
    },
    device: {
      restrictions: restrictionReported
        ? {
          state: 'restriction-reported',
          detail: 'The operating system reported a restricted media permission. This does not identify the policy source.',
        }
        : {
          state: 'unknown',
          detail: 'No general managed-device or security-policy status is available through the supported APIs used here.',
        },
    },
  };
}

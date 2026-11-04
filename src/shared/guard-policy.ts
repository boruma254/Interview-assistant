import type { GuardPolicySettings } from './contracts';

export type GuardOperation = 'ai' | 'microphone' | 'transcription';

export function guardPolicyDenial(
  policy: GuardPolicySettings,
  sessionConsent: boolean,
  privacyModeActive: boolean,
  operation: GuardOperation,
): string | null {
  if (privacyModeActive) return 'Screen-Sharing Privacy Mode is active. Turn it off before starting AI or transcription.';
  if (!sessionConsent) return 'Confirm session consent in Companion Guard before using AI or microphone features.';
  if (policy.restrictedMode) return 'The requested feature is disabled by the Companion Guard restricted-mode policy.';
  if (operation === 'ai' && !policy.allowAiAssistance) return 'AI assistance is disabled by the Companion Guard policy.';
  if (operation === 'microphone' && !policy.allowMicrophoneRecording) return 'Microphone recording is disabled by the Companion Guard policy.';
  if (operation === 'transcription' && !policy.allowTranscription) return 'Transcription is disabled by the Companion Guard policy.';
  return null;
}

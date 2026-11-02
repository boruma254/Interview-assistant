export type RecordingState = 'idle' | 'recording' | 'paused' | 'ready';
export type RecordingEvent = 'start' | 'permission-denied' | 'device-missing' | 'pause' | 'resume' | 'stop' | 'transcribed' | 'discard';

export function transitionRecordingState(state: RecordingState, event: RecordingEvent): RecordingState {
  const transitions: Record<RecordingState, Partial<Record<RecordingEvent, RecordingState>>> = {
    idle: { start: 'recording', 'permission-denied': 'idle', 'device-missing': 'idle' },
    recording: { pause: 'paused', stop: 'ready' },
    paused: { resume: 'recording', stop: 'ready' },
    ready: { transcribed: 'idle', discard: 'idle' },
  };
  return transitions[state][event] ?? state;
}

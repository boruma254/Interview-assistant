import type { ChatEvent } from './contracts';
import type { ChatMessage } from './contracts';

export type DisplayMessage = ChatMessage & { id: string; streaming?: boolean; error?: boolean };

export function applyChatEvent(messages: DisplayMessage[], answerId: string, event: ChatEvent): DisplayMessage[] {
  if (event.requestId.length === 0) return messages;
  return messages.map(message => {
    if (message.id !== answerId) return message;
    if (event.error) return { ...message, error: true, text: event.error, streaming: false };
    if (event.delta) return { ...message, text: message.text + event.delta };
    if (event.done) return { ...message, streaming: false };
    return message;
  });
}

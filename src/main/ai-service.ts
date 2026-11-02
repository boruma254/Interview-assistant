import OpenAI from 'openai';
import type { AppSettings, ChatMessage } from '../shared/contracts';

export interface AIProvider {
  stream(
    messages: ChatMessage[],
    settings: AppSettings,
    apiKey: string,
    signal: AbortSignal,
    onDelta: (delta: string) => void,
  ): Promise<void>;
}

export interface TranscriptionProvider {
  transcribe(audioBase64: string, mimeType: string, apiKey: string, endpoint?: string): Promise<string>;
}

export class OpenAIProvider implements AIProvider {
  async stream(messages: ChatMessage[], settings: AppSettings, apiKey: string, signal: AbortSignal, onDelta: (delta: string) => void) {
    const client = new OpenAI({
      apiKey,
      ...(settings.apiEndpoint.trim() ? { baseURL: settings.apiEndpoint.trim() } : {}),
      timeout: 45_000,
      maxRetries: 1,
    });
    const stream = await client.responses.create({
      model: settings.model,
      instructions: [
        'You are Interview Companion, a concise learning and interview-practice assistant.',
        `Use a ${settings.responseStyle} response style.`,
        'For behavioral questions, suggest a STAR structure and mark where the user must insert real experience.',
        'Never invent personal experience, qualifications, metrics, or achievements for the user.',
        'Help the user understand and explain answers in their own words.',
      ].join(' '),
      input: messages.map(message => ({ role: message.role, content: message.text })),
      stream: true,
      max_output_tokens: settings.maxResponseLength,
    }, { signal });

    let completed = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') onDelta(event.delta);
      if (event.type === 'response.completed') completed = true;
      if (event.type === 'error') throw new Error('The AI provider reported a response error.');
    }
    if (!completed && !signal.aborted) throw new Error('The AI stream ended before the response completed.');
  }
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  async transcribe(audioBase64: string, mimeType: string, apiKey: string, endpoint = ''): Promise<string> {
    const client = new OpenAI({
      apiKey,
      ...(endpoint.trim() ? { baseURL: endpoint.trim() } : {}),
      timeout: 60_000,
      maxRetries: 1,
    });
    const extension = mimeType === 'audio/mp4' ? 'm4a' : mimeType === 'audio/ogg' ? 'ogg' : mimeType === 'audio/wav' ? 'wav' : 'webm';
    const file = new File([Buffer.from(audioBase64, 'base64')], `recording.${extension}`, { type: mimeType });
    const result = await client.audio.transcriptions.create({ file, model: 'gpt-4o-mini-transcribe' });
    return result.text;
  }
}

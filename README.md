# Interview Companion

A visible, user-controlled Electron desktop app for permitted interview practice, demonstrations, presentations, and software-development support. It provides manual streaming chat, explicit microphone recording with an editable transcript, window controls, settings, and a pre-presentation privacy checklist.

## Requirements and installation

- macOS or Windows for the desktop application. Linux is useful for development but is not a packaged target here.
- Node.js 22.12 or newer (required by the packaged Electron runtime). Use a currently supported LTS release for production builds.
- npm 10 or newer. This repository uses npm and commits a `package-lock.json`; use `npm ci` for reproducible installs.
- An OpenAI API key for chat and transcription. Requests are made only after you submit a chat message or explicitly select **Transcribe**.

```bash
npm ci
# If npm 11 blocks Electron's binary download, explicitly approve its runtime install:
npm install-scripts approve electron
npm rebuild electron
cp .env.example .env
```

The Electron approval/rebuild commands are needed only when npm reports that Electron's install script was blocked; Electron's install script downloads the official runtime binary.

For local development, add `OPENAI_API_KEY` to `.env`. Alternatively, start the app and enter the key in **Settings**; it is encrypted with the operating system's Electron safe storage and is not exposed to the renderer. Do not commit `.env` or distribute a shared API key.

## Run and validate

```bash
npm run dev          # start Electron and Vite
npm run typecheck    # strict TypeScript check
npm test             # unit and renderer tests; no real API key required
npm run build        # production Electron/Vite build
```

To package on the matching operating system:

```bash
npm run dist:mac     # macOS app and DMG
npm run dist:win     # Windows NSIS installer
```

Packaging scripts use `electron-builder`. Windows and macOS packages must be built and tested on the corresponding OS/CI runner; a build on another OS does not verify the target installer. Public distribution requires platform signing/notarization credentials and certificates. macOS microphone permission text is included in the app metadata; signing and notarization are not configured.

## Providers and configuration

The implemented chat and speech-to-text provider is OpenAI. Settings allow choosing a model, response style, maximum output length, history limit, and an optional compatible API endpoint. Speech transcription uses `gpt-4o-mini-transcribe`. Configure model availability and billing with your provider.

`.env.example` lists supported development environment variables:

- `OPENAI_API_KEY` — optional development credential; settings can store it securely instead.
- `OPENAI_MODEL` — optional development model override (default: `gpt-4o-mini`).

The app's custom API endpoint sends the API key and prompts to that endpoint; use only a provider you trust. HTTPS is required except for localhost testing. Renderer components never receive the API key. Settings and encrypted credentials are written under Electron's per-user application data directory. Conversation content is kept in renderer memory only and is not saved to disk.

## Microphone workflow and permissions

Click the microphone icon beside the chat input to request microphone permission and start recording. An animated recording indicator and elapsed time show that capture is active. Click the pause icon to stop capture and immediately transcribe into the editable message box without sending it. Click the send icon while recording to stop, transcribe, and submit the transcript for an AI response. Transcription is batch-based; live partial transcription is not implemented. Recording does not start in the background, and system audio is not captured.

On macOS, allow microphone access in System Settings if prompted. On Windows, allow desktop microphone access in Privacy & security settings. A selected microphone is used when available; the system default is used otherwise. Browser/Electron codec support can vary. The app reports permission denial, missing devices, unsupported recording, and transcription failures in its status area. Voice activity requires an explicit user action.

## Interface and privacy

- The app opens as a compact, labeled Interview Companion toolbar with a message field and microphone/send controls. It stays above normal application windows by default; use **Pinned** to turn that off. **Expand** opens the full chat and settings; **Toolbar** returns to the compact view. The toolbar does not capture or analyze screen contents.
- **Chat** supports Enter to send, Shift+Enter for a newline, streamed output, cancellation, retry, copying, clearing the conversation, and microphone-to-text sending from the composer.
- **Pin**, **Compact**, **Minimize**, and **Close** control the visible floating window. `CommandOrControl+Shift+Space` toggles its visibility by default; change the accelerator in Settings if the shortcut conflicts with another app.
- **Presentation mode** includes a user-controlled checklist and a reminder to verify the sharing app's own preview.
- **Overlay lab** opens an app-owned local test window. It displays that page's focus, visibility, and fullscreen state so you can observe ordinary window switching and OS fullscreen behavior. It does not load remote content or inspect other applications. See [the research plan](docs/overlay-lab-plan.md) for the evaluation procedure.
- The app does not collect screen contents, enumerate other applications, or attempt to evade assessment monitoring. No window is guaranteed to be excluded from screenshots, recordings, or remote sessions; actual capture depends on the OS, permissions, sharing app, and capture method.

## Troubleshooting

- **`npm install` reports `ERESOLVE`**: use Node.js 20+ and the npm version recommended above, then run `npm ci` from the directory containing `package-lock.json`. Do not use `--force` to conceal peer conflicts.
- **Electron fails to launch**: remove only the project `node_modules` directory and run `npm ci`; check that the host OS can launch the bundled Electron runtime.
- **Missing API key / 401**: add a key through Settings or `.env`, verify provider access, and restart after changing `.env`.
- **429 or network errors**: verify provider quota, endpoint, model, and network availability; retry after rate limits clear.
- **Microphone access fails**: enable the OS permission, connect a microphone, and restart the app if the OS permission state was changed while it was open.
- **No audio codec available**: use a supported macOS/Windows Electron runtime or transcribe from a supported recording format.
- **Shortcut does not work**: another application may own that global accelerator; choose an unused shortcut in Settings.

## Known limitations

The only implemented online providers are OpenAI-compatible chat and OpenAI transcription. Other providers, live partial transcription, account sign-in, cloud conversation history, code signing, notarization, and cross-platform installer verification are not included. `npm run build` validates the local production bundle but does not produce a signed installer. Voice capture records microphone input only; transcription requires network access and sends the selected recording to the configured endpoint.

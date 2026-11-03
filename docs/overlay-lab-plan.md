# Overlay architecture study plan

## Goal

Demonstrate the boundaries between browser-rendered content, OS user-space window APIs, and operating-system display composition using a visible, user-controlled Interview Companion overlay and an app-owned local test window.

## Scope and constraints

- Use only synthetic content served from the application itself.
- Keep the companion labeled, visible, and controlled by the user through Pin, the keyboard shortcut, and the window controls.
- Observe only the local test window's own focus, visibility, and fullscreen state.
- Do not capture the screen, enumerate unrelated applications, inspect browser tabs, or connect to interview or assessment sites.
- Let the operating system control fullscreen and protected display behavior.

## Implementation phases

1. **Overlay baseline:** use Electron's normal always-on-top and workspace APIs, controlled by the existing Pin setting.
2. **Local test harness:** open a separate, non-pinned BrowserWindow containing synthetic content, focus/visibility indicators, and a fullscreen control.
3. **Layer explanation:** show what page JavaScript can report about its own document, what the main process can request from the OS, and what the compositor controls.
4. **Manual evaluation:** record OS/version, pin state, workspace, focus state, fullscreen state, and whether the companion remains visible.
5. **Analysis:** compare results by OS and explain where the browser API, Electron/OS API, and compositor responsibilities begin and end.

## Evaluation procedure

1. Launch Interview Companion, expand the window, and select **Overlay lab**.
2. Leave **Pin** on, open the local test window, and switch focus between it and another ordinary window.
3. In the test window, enter and leave fullscreen. Record the companion's visibility.
4. Repeat with Pin off and, where supported, on another workspace.
5. Repeat on each target operating system and report differences without generalizing one platform's behavior to another.

## Success criteria

- The overlay is visibly labeled and Pin can be toggled by the user.
- The test window contains no remote content and reports only its own browser document state.
- The student can reproduce ordinary window switching and fullscreen observations.
- Findings clearly distinguish browser state, OS window requests, and compositor policy.

## Limitations

Workspace and fullscreen behavior varies across operating systems and desktop environments. The harness is an observational demonstration, not a security monitor or a guarantee about what third-party screen-sharing or assessment software captures.

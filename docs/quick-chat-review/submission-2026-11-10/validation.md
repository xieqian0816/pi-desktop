# Quick Chat revision evidence

**Code tested:** `a666660e25748f8c12611d9e1cc84cc3261f3b06`  
**Base:** `FaqFirebase/pi-desktop:Dev` at `6ec88e3fa365a971688b09f4face441b94b71c34`  
**Host:** macOS 27.0, Apple Silicon; Electron 43.8.3; Node 22.23.2.

## Automated checks

The feature candidate passed `npm run typecheck`, `npm run lint`, all **2,211 tests**, and `npm run build`. The separate background-session prerequisite passed the same checks with **2,085 tests**. The independent planning-prompt change passed with **2,048 tests**. See the code PR for the resulting manual GitHub Actions run.

## Native Electron checks

The app ran with actual Pi 1.3.0 and OMP 18.18.2 executables, isolated home/config/session directories, a scratch project, and a local deterministic OpenAI-compatible test server. No external model service or personal session/configuration was used.

With Quick Chat closed, each engine passed: lazy project start, send and reply, switching the runtime model (verified against the next HTTP request), queueing a second message until the current turn completes, denying a file-write approval, allowing a file-write approval, and retaining an unsent draft through Settings and back to Chat. The window count stayed at one.

Quick Chat passed **14 scenarios per engine**: palette entry and unassigned draft, native Pin/blur behavior, file mention, slash completion, live engine model catalog, streamed reply, prompt recall, permission prompt, one live tool card, approval handoff, same-process continuation, independent background work, microphone setup entry, and one settled tool card.

### Main-window captures

The project sidebar is cropped out of these captures to avoid publishing the local temporary workspace path.

| Pi | OMP |
|---|---|
| [Queued while a turn runs](pi-main-queued.jpg) | [Queued while a turn runs](omp-main-queued.jpg) |
| [Permission denied](pi-main-deny.jpg) | [Permission denied](omp-main-deny.jpg) |
| [Permission allowed](pi-main-allow.jpg) | [Permission allowed](omp-main-allow.jpg) |

### Quick Chat captures

| Pi | OMP |
|---|---|
| [Streamed reply](pi-popup-reply.jpg) | [Streamed reply](omp-popup-reply.jpg) |
| [Approval pending](pi-popup-approval.jpg) | [Approval pending](omp-popup-approval.jpg) |
| [Settled transcript](pi-popup-settled.jpg) | [Settled transcript](omp-popup-settled.jpg) |

Machine-readable scenario list: [native-results.json](native-results.json).

## Limits

Native window and focus checks were run on macOS only. Windows/Linux window behavior, global shortcut activation by the operating system, and actual speech recognition were not exercised. The microphone setup entry was checked; no speech model was installed. The test server returned deterministic local responses and does not assess model quality.

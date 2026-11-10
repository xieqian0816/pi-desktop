Thanks for the detailed review. I reworked the branch around the main concern: Quick Chat now uses the main chat's composer, model/thinking selectors, approval UI, message rendering, and streaming components. The remaining popup controller owns only popup-specific session binding/selection, drafts, submission, and stale-operation handling; it no longer contains separate composer, model-picker, or approval components.

I also addressed the related items:

- The planning-prompt move is isolated in #116; generic background-session/runtime work is isolated in #117. Both target `Dev`, and #108 depends on them. Relative to the clean merge candidate for those prerequisites, #108's remaining layer is 66 files (+7,067/−698), including tests and main-window integration.
- Quick Chat is available from Ctrl/Cmd+K in the main window. A new task stays unassigned until the user picks a project, rather than defaulting to home. Pin is hidden on Wayland when unsupported, while explicit X11 remains available.
- Turkish strings and the shorter README are included. I tested both Pi and OMP.

At `a666660e25748f8c12611d9e1cc84cc3261f3b06`, typecheck, lint, build, and all 2,211 tests pass. Native Electron checks on macOS passed for Pi and OMP: seven main-window scenarios per engine with Quick Chat closed, and fourteen popup scenarios per engine. The evidence link includes the checks, scenarios, captures, scripts, and limits.

I have not validated native Windows/Linux behavior on this final head. Earlier platform results in the thread were from an older commit and are not being presented as proof for this revision. I also cannot dispatch the upstream Build workflow from my read-only account, so there are no hosted PR checks. I am keeping #108 Draft until #116/#117 are integrated and maintainers decide or run the remaining Windows/Linux validation. If you can run the native platform check against this head, the result can be added before marking it ready.

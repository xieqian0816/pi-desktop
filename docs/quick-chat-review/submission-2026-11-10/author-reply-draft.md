Thanks for the detailed review. I updated Quick Chat to use the main chat's composer, model/thinking selectors, and approval UI, while keeping its session binding and draft handling in the popup controller. The background-session work is now separated in #117, with the planning-prompt relocation in #116.

I also checked the main window with Quick Chat closed: Pi and OMP both send, queue behind an active turn, apply a changed model, honor denied/allowed write approvals, and retain an unsent draft across navigation. The popup was exercised with both engines for model discovery, approval handoff, background activity, and window behavior. The PR remains a draft while the two prerequisites are reviewed.

The commit-bound checks and captures are linked from the PR description. Native window checks were on macOS; I have not claimed Windows/Linux native coverage or speech-recognition testing.

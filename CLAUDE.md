# CLAUDE.md

Coding rules for this project (backend: `WellnessBackend` — Express + Mongoose, ESM/tsx; frontend: `C:\workspace\backend-mdw\WellnessFrontend` — Next.js dashboard). These override default behavior — follow them on **every** change.

## Write clean, modular, scalable code — without over-engineering

1. **Readable first.** Match the surrounding style. Clear names over clever ones. Keep functions and files small and single-purpose — if a file is doing too much, split it. Comments explain *why*, not *what*.

2. **Reuse, never duplicate.** Grep before you write — if a helper, component, or mapping already exists, use it. Shared logic lives in exactly **one** place. If you catch yourself copy-pasting a badge, a formatter, a status map — extract it and point every caller at it. Never add a second (or fourth) copy of the same thing.

3. **No half-fixes — wire it everywhere.** When you add a field, a side-effect, or a rule, it must reach **every** path that creates or displays that thing — all endpoints, all views. Route creation/derivation through one service (e.g. `lib/bookingService.ts`); don't scatter it across controllers. (Half-wired changes are exactly what caused the "missing side details" bug.)

4. **Scalable, not over-built.** Design for the next *real* use, not hypothetical futures. YAGNI — no extra abstraction, config, or generality until 2+ real callers need it. The simplest thing that works today and extends cleanly tomorrow.

5. **Avoid complexity.** Fewer moving parts. Flat over deeply nested. Explicit over magic. No clever code that needs a comment to decode. If a solution feels complicated, stop and simplify.

## Before calling a change "done"
- Grep for duplicates of what you just wrote — did you **replace** old copies, or add another one?
- Does the change reach **every** create-path and **every** display surface?
- Would a new dev understand the file without asking?
- Typecheck passes.

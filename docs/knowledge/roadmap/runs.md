# roadmap-max runs

## 2026-05-21 — Phase 24 audit-pass

- Closed: 18, Skeleton: 8, Blocked: 1, Reverted: 0.
- Baseline 2073 tests → 2125 (+52); lint=0; compile OK.

### Surprising blockers (couldn't predict up-front)

- `Dropbox-API-Arg.rev`-based 304 emulation cost an extra `get_metadata`
  RPC per pull but is still net-positive vs always downloading full
  bodies. Not a real blocker, but worth noting that Dropbox's HTTP
  contract is *not* RFC-7232 compatible — adapters can't be uniform
  across all four providers.

- `@typescript-eslint/no-unnecessary-condition` fires on
  `valid[0]` even when `valid.length === 0` is checked above, because
  `noUncheckedIndexedAccess` is off in `tsconfig.json`. Forced array
  destructuring patterns (`const [first, ...rest]`) over `valid[0]!`
  in pure helpers.

- 14 command titles in `package.json` were hardcoded English instead
  of NLS keys — silent UX bug, only visible to non-English locales.
  Russian translations *were* already in `package.nls.ru.json` (dead
  keys never wired). Easy fix once spotted.

### Patterns adopted this run

- **Pure planner + sentinel error class** for every skeleton:
  `*NotReadyError`, `*NotImplementedError`, `*NotConnectedError`.
  UI catches by name and routes to «work in progress» state instead
  of degrading silently. Eight skeletons follow this pattern.

- **`_shared/fetchWithTimeout.ts`** in `src/providers/` — single source
  of truth for HTTP timeout + abort + tracing across all four
  providers. Standardised `{ channel, timeoutMs }` opts. Future
  providers (S3, GH Releases) plug in unchanged.

- Test fixtures **never** use real machine names / workspace names
  even as innocuous strings — abstract `work-laptop`, `home-desktop`,
  `alpha-workspace` instead. User flagged a `059-1-ws-346` carry-over
  from a screenshot during this run.

### Items left explicitly to the next phase

- Wiring for Phase 24 skeletons (F2 / F6 / U3 / X2 / M1 / M2 / M4 / M5).
- WebRTC P2P signaling (X3) — requires real signaling server, kicked
  to v2.5.
- README / continuity.md updates — only after real-world QA of new
  features so docs don't drift from observed behaviour.

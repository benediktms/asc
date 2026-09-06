## Why

ACS currently appends peer messages to thread history for a later turn or asks the recipient to poll its durable inbox. That delays collaboration and can hide messages from an agent that is already working. Peer messages should enter the recipient Codex session through a native active-input path so the agent can process them without the user acting as a relay.

Codex already exposes a provenance-preserving mechanism for this: `turn/start` with empty user input and named `toolOutput`. The same request can start an idle recipient turn or be accepted into a supported active regular turn. This gives ACS one direct session-delivery path without presenting peer content as the local user.

## What Changes

- Make direct native delivery the normal ACS communication path: submit the canonical peer envelope as named `toolOutput` to the bound Codex session.
- When the recipient is idle, the submission starts a turn; when Codex accepts it into an active supported turn, ACS records the existing turn relationship instead of pretending it owns a new turn.
- Keep the delivery pending when ACS cannot reach the app-server that owns the recipient thread or when the runtime rejects active input; do not fall back to history-only context append.
- Correlate direct deliveries with the accepting runtime turn while allowing several peer messages/tasks to share one turn.
- Require explicit task-specific completion/failure/input actions for all delegated tasks. Runtime turn completion no longer implies A2A task completion.
- Prevent cancellation of one peer task from interrupting a shared/user-owned turn unless isolated ACS ownership of that runtime execution is proven.
- Preserve durable acceptance, binding fences, idempotency, ambiguous-write reconciliation, peer provenance, and local approval ownership.
- Replace the public `wake_when_idle` / `append_context` / `join_active` choice with one `direct` delivery behavior. **BREAKING**
- Update the initial schema/contracts directly; ACS has no deployed compatibility or data-migration obligation yet.
- Rework open delivery, compatibility, and end-to-end PRs against this contract before merging them.

## Why Not `turn/steer` with context only?

The pinned Codex protocol exposes `turn/steer`, `expectedTurnId`, and untrusted `additionalContext`, but the pinned upstream Codex implementation explicitly rejects a steer request when `input` is empty. Adding a fabricated local `UserInput` solely to satisfy that API would change the authority of peer content, so this proposal does not use it for ACS messaging.

Exact-turn conditional delivery may be added later if Codex exposes a provenance-preserving primitive for it. Normal ACS messaging is session-addressed: send the message to the logical agent's live bound session and record the turn that actually accepted it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-delivery`: Deliver peer messages through runtime-native named tool-output start-or-join submission, track the actual turn relationship, support many deliveries per turn, and remove history-only append behavior.
- `a2a-messaging`: Schedule every accepted peer message for direct delivery without exposing context-append and wake policy modes, and require explicit task terminal actions.

## Impact

- Runtime adapter and Codex protocol codec, including native named-tool-output input, execution-relationship evidence, and active-session capability tests.
- A2A delivery extension, MCP send schema, control contracts, persisted delivery representation, scheduler policy, configuration, diagnostics, and task-completion semantics.
- Runtime execution/delivery correlation so one turn may carry several peer deliveries.
- Cancellation semantics for shared turns.
- Focused adapter, scheduler, A2A, MCP, storage, and real-Codex tests.
- Existing work in https://github.com/benediktms/acs/pull/14, https://github.com/benediktms/acs/pull/15, https://github.com/benediktms/acs/pull/16, https://github.com/benediktms/acs/pull/19, https://github.com/benediktms/acs/pull/35, and the polling fallback delivered by https://github.com/benediktms/acs/pull/36.

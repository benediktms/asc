## Why

ACS currently appends peer messages to thread history for a later turn or asks the recipient to poll its durable inbox. That delays collaboration and can hide messages from an agent that is already working; peer messages should enter the recipient's active Codex turn immediately.

## What Changes

- Make direct delivery the normal ACS communication path: steer a steerable active turn with untrusted additional context, or start a new turn with named tool output when the recipient is idle.
- Keep the delivery queued when ACS cannot reach the app-server that owns the recipient thread or when the active turn rejects steering; do not fall back to history-only context append.
- Correlate direct deliveries with the target turn and retain durable acceptance, binding fences, idempotency, and ambiguous-write reconciliation.
- Preserve peer provenance and local approval ownership: direct delivery never presents peer content as user, developer, or system authority.
- Replace the public `wake_when_idle` / `append_context` delivery choice with one `direct` delivery behavior. **BREAKING**
- Rework open delivery, compatibility, and end-to-end PRs against this contract before merging them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-delivery`: Deliver messages into the active Codex turn with `turn/steer`, start an idle recipient turn, and remove history-only append behavior.
- `a2a-messaging`: Schedule every accepted peer message for direct delivery without exposing context-append and wake policy modes.

## Impact

- Runtime adapter and Codex protocol codec, including capability evidence for `turn/steer` and untrusted `additionalContext`.
- A2A delivery extension, MCP send schema, control contracts, persisted delivery modes, scheduler policy, configuration, diagnostics, and migration of existing rows.
- Focused adapter, scheduler, A2A, MCP, storage, and real-Codex tests.
- Existing work in https://github.com/benediktms/acs/pull/14, https://github.com/benediktms/acs/pull/15, https://github.com/benediktms/acs/pull/16, https://github.com/benediktms/acs/pull/19, https://github.com/benediktms/acs/pull/35, and the polling fallback delivered by https://github.com/benediktms/acs/pull/36.

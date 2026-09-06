## Context

See `proposal.md` for motivation. The current runtime adapter uses `thread/inject_items` for history-only delivery and `turn/start` for opt-in wake delivery. The pinned Codex protocol also exposes `turn/steer` with an `expectedTurnId` precondition and `additionalContext` entries whose kind can be `untrusted`. The adapter currently connects to one configured app-server, so a bound thread is directly reachable only when that server owns or hosts it.

Open pull requests build on the old split between append and wake delivery. In particular, https://github.com/benediktms/acs/pull/16 hardens the idle-check race, https://github.com/benediktms/acs/pull/15 codifies the end-to-end flow, and https://github.com/benediktms/acs/pull/19 owns capability evidence and generated protocol boundaries. The merged polling fallback in https://github.com/benediktms/acs/pull/36 remains useful for diagnostics but is no longer a successful delivery path.

## Goals / Non-Goals

**Goals:**

- Put peer messages into the model-visible input of the exact active recipient turn.
- Preserve untrusted peer provenance and local ownership of approvals and user input.
- Keep durable acceptance distinct from runtime acceptance.
- Give every direct attempt an exact delivery marker and turn correlation.

**Non-Goals:**

- Taking ownership of Codex approvals, user-input requests, settings, or cancellation for user-owned turns.
- Resuming a second copy of a thread whose owning app-server is unknown.
- Treating inbox reads or history append as successful automatic delivery.

## Decisions

### Use `turn/steer` with untrusted additional context for active turns

After inspecting the recipient, the adapter sends `turn/steer` with the observed active turn as `expectedTurnId`, an empty user-input array, and one `additionalContext` entry keyed by the delivery ID. The entry has kind `untrusted` and its value is the canonical delivery envelope.

The turn precondition closes the inspect/mutate race: a changed turn causes deferral instead of contaminating a different turn. Empty user input avoids presenting a peer as the local user. The alternative of `thread/inject_items` is rejected because it waits for a future turn. Supplying peer text as `UserInput` is rejected because it loses the security provenance.

### Start an idle turn with named tool output

For an idle reachable thread, the adapter uses the existing empty-input `turn/start` request with the canonical envelope in `toolOutput`. It records the returned turn ID before reporting runtime acceptance. This retains the existing dedicated-turn result correlation and avoids a second delivery mechanism.

### Defer when direct delivery is unavailable

Dormant, unloaded, offline, stale, and non-steerable targets remain pending with a precise reason. The scheduler retries from a fresh session inspection. It never downgrades to history append. A target binding must resolve to an app-server route that can observe and mutate the bound thread; shared-endpoint setup or ACS-owned runtime creation supplies that route.

The alternative of automatically resuming an unreachable thread is rejected because ACS cannot prove that another app-server is not already running it. Polling remains an operator diagnostic, not delivery acceptance.

### Model turn correlation as many deliveries to one execution

An existing active turn may receive several delivery IDs. Runtime execution storage therefore associates a turn with multiple delivery attempts instead of storing one delivery per turn. Each steer-accepted task stays working until the recipient explicitly completes, fails, or requests input for it. Only a turn started by ACS for one delivery may use its final output for automatic task completion.

This avoids attributing one shared final response to unrelated tasks while retaining exact runtime evidence for each injected message.

### Replace delivery mode selection with `direct`

New A2A and MCP requests create direct delivery intents without a caller-selected mode. Removed mode values fail validation. A storage migration rewrites pending `wake_when_idle`, `append_context`, and `join_active` intents to `direct`; terminal attempts remain immutable audit history. Per-binding wake configuration and the `allowActiveTurnSteering` flag are removed because steering is now the defined delivery path rather than an experimental fallback.

## Risks / Trade-offs

- **Some Codex turns reject steering** -> Keep the message pending and retry after the turn changes; never append it silently.
- **A recipient session is hosted by another app-server** -> Report the route as unavailable and require shared-endpoint or ACS-owned runtime attachment before automatic delivery can succeed.
- **A steer response is lost after write** -> Reconcile only from an exact delivery marker in the expected turn; otherwise retain `acceptance-unknown` for operator resolution.
- **Several tasks share one active turn** -> Require explicit task terminal actions for steer-injected work and do not fan out the shared final response.
- **Existing PRs encode old delivery modes** -> Rebase and revise the compatibility, safe-wake, and end-to-end branches after this spec is accepted.

## Migration Plan

1. Land the capability and persistence changes together so new writers cannot create removed delivery modes.
2. Rewrite only non-terminal legacy intents to `direct`, preserving their identifiers, binding epochs, attempts, and idempotency records.
3. Remove history-only delivery and wake policy configuration after readers understand `direct`.
4. Gate active steering on real-Codex compatibility evidence for the pinned runtime profile.
5. Rework the affected open PRs, then run focused adapter, scheduler, A2A, MCP, storage, and real-Codex checks.

Rollback requires stopping the daemon before restoring the previous binary and database backup because migrated pending intent modes are not understood by the old binary.

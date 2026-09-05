# ADR-009: Wake is capability and policy controlled

Status: accepted

Context-only injection is supported. Codex wake remains an explicit per-binding
non-atomic opt-in until a named tool-output queue primitive removes the
active-turn race.

The effective strategy is the persisted
`binding.deliveryPolicy.wakeStrategy`, returned by binding get/list and bind or
claim responses. `acs codex doctor` reports the configured default for new
bindings separately from the runtime's atomic capability; changing the config
does not retroactively change an existing binding. Delivery get/list exposes the
current effective strategy and whether it came from the pinned binding or the
target's current active binding; the existing delivery reason reports why a
wake is deferred or rejected.

With `atomic-only`, a runtime that reports `atomicDeferredWake: false` does not
receive a wake attempt. The delivery remains deferred as
`manual-wake-required`. With `non-atomic-idle-check`, every attempted wake emits
the `delivery.non-atomic-wake-attempt` audit event, including binding epoch,
runtime atomic capability, and the residual `inspect-start-race` risk. Enabling
that policy through binding or claim also emits
`binding.non-atomic-wake-enabled`.

The Codex adapter inspects for idle immediately before `turn/start`, but another
client can start a turn between those operations. A deterministic conformance
test exercises that interleaving. When app-server rejects `turn/start` because
a turn is already running, the adapter defers the delivery as `busy`; it does
not report acceptance or retry the mutation inside the adapter. This is safe
handling of the race, not atomic wake semantics.

Shared app-server attachment does not transfer TUI request or approval
ownership to ASC. The topology evidence remains scoped to ADR-011; non-atomic
wake opt-in does not broaden it.

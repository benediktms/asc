## Why

Direct peer-message delivery can be accepted by a recipient runtime before the model actually observes the message. A recipient may be deep in a long-running tool-heavy turn, so normal delivery can have noticeable processing latency even though the app-server accepted the message. ACS needs to model that honestly and define when an authorized sender may request stronger intervention.

## What Changes

- Define three peer-message urgency levels: `normal`, `high`, and `preempt`.
- Keep `normal` as the default direct-delivery behavior: submit through the runtime-native message path without interrupting current work.
- Define `high` as scheduling priority only; it may be attempted before lower-priority pending messages but MUST NOT imply runtime interruption.
- Define `preempt` as an explicitly authorized request to interrupt the current runtime execution, when the adapter can prove the target execution and the policy permits interruption, then submit the peer message through normal direct delivery.
- Separate runtime acceptance from model observation/acknowledgement and from task reply/completion.
- Require runtime-neutral capability reporting for interruption and avoid leaking Codex-specific `turn/interrupt` into application/domain code.
- Update or supersede stale wake-oriented ADR guidance so ADRs and OpenSpec remain consistent.

## Capabilities

### Modified Capabilities

- `runtime-delivery`: add urgency and preemption semantics around direct delivery, including explicit runtime-interrupt capability and observability boundaries.

## Impact

- Runtime-neutral delivery contracts and runtime capability reporting.
- Codex adapter mapping for `turn/interrupt` plus subsequent named-tool-output direct delivery.
- Delivery scheduling priority and authorization policy.
- Runtime execution ownership checks and cancellation/preemption safety.
- Observability for runtime acceptance versus agent acknowledgement/reply.
- ADR-009 and related runtime-delivery documentation.

## Non-Goals

- Guaranteeing that a `normal` or `high` message is observed immediately by the model.
- Treating high priority as permission to cancel tools or approvals.
- Allowing arbitrary peer agents to interrupt user-owned turns.
- Inventing a provider-independent concept of "model has read this" when the runtime cannot provide authoritative evidence.

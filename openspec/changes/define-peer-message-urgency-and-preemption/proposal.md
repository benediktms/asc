## Why

Direct peer-message delivery can be accepted by a recipient runtime before the model actually observes the message. A recipient may be deep in a long-running tool-heavy turn, so normal delivery can have noticeable processing latency even though the app-server accepted the message. ACS needs to model that honestly and define when an authorized sender may request stronger intervention.

The repository is also in the middle of moving to OpenSpec. To avoid two competing architecture/specification systems, this change formalizes `openspec/specs` as the sole normative source for behavioral and architectural requirements. Existing ADRs may remain as historical records, but they must not carry requirements that are absent from OpenSpec.

## What Changes

- Define three peer-message urgency levels: `normal`, `high`, and `preempt`.
- Keep `normal` as the default direct-delivery behavior: submit through the runtime-native message path without interrupting current work.
- Define `high` as scheduling priority only; it may be attempted before lower-priority pending messages but MUST NOT imply runtime interruption.
- Define `preempt` as an explicitly authorized request to interrupt the current runtime execution, when the adapter can prove the target execution and the policy permits interruption, then submit the peer message through normal direct delivery.
- Separate runtime acceptance from model observation/acknowledgement and from task reply/completion.
- Require runtime-neutral capability reporting for interruption and avoid leaking Codex-specific `turn/interrupt` into application/domain code.
- Make OpenSpec the single normative specification/architecture source. Audit existing ADRs for unique requirements, promote those requirements into OpenSpec, then retain ADR files only as historical/non-normative records or archive them.

## Capabilities

### New Capabilities

- `specification-governance`: define OpenSpec as the sole normative source and the treatment of legacy ADRs.

### Modified Capabilities

- `runtime-delivery`: add urgency and preemption semantics around direct delivery, including explicit runtime-interrupt capability and observability boundaries.
- `a2a-messaging`: allow an authorized sender to express message urgency without conflating priority with task authority.

## Impact

- Runtime-neutral delivery contracts and runtime capability reporting.
- Codex adapter mapping for `turn/interrupt` plus subsequent named-tool-output direct delivery.
- Delivery scheduling priority and authorization policy.
- Runtime execution ownership checks and cancellation/preemption safety.
- Observability for runtime acceptance versus agent acknowledgement/reply.
- `openspec/config.yaml`, README development guidance, and legacy `docs/adr` references.
- Existing ADR contents must be audited so no still-valid normative requirement disappears when ADRs become non-authoritative.

## Non-Goals

- Guaranteeing that a `normal` or `high` message is observed immediately by the model.
- Treating high priority as permission to cancel tools or approvals.
- Allowing arbitrary peer agents to interrupt user-owned turns.
- Inventing a provider-independent concept of "model has read this" when the runtime cannot provide authoritative evidence.
- Maintaining ADRs as a parallel normative architecture system.

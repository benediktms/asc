## Context

The merged direct-delivery design submits peer messages through a runtime-native input primitive rather than history append. For Codex, the selected path is named `toolOutput` through `turn/start`, which may start an idle turn or be accepted into a supported active turn. Runtime acceptance therefore does not necessarily mean the model has observed the message yet: an active turn may still be executing tools before the next model-inference boundary.

Codex also exposes `turn/interrupt`, but interruption is materially stronger than ordinary message delivery. It can stop unrelated local work if ACS does not own the execution. This change defines urgency and preemption without conflating message priority, delivery acceptance, and execution ownership.

The repository already states that `openspec/specs` is the source of truth for behavioral requirements, but existing documentation still asks contributors to keep ADRs and OpenSpec mutually consistent. That leaves two places where architecture can appear normative and has already allowed ADR-009 to become stale after the direct-delivery decision. This change makes OpenSpec the sole normative architecture/specification source.

## Decisions

### Define three urgency levels

```ts
type MessageUrgency = "normal" | "high" | "preempt";
```

`normal` is the default. It uses the existing direct-delivery path and never interrupts the current execution.

`high` raises scheduler priority for a pending delivery but uses the same non-interrupting runtime-delivery semantics as `normal`. A runtime adapter MAY expose a native non-destructive priority primitive in the future, but ACS SHALL NOT emulate priority by canceling current work.

`preempt` requests an explicit interruption sequence. It is not a stronger form of `high`; it is a separately authorized control action.

### Model processing latency honestly

ACS distinguishes at least these milestones:

```text
durable-accepted
runtime-accepted
agent-acknowledged (when explicitly reported)
replied / task-transitioned
```

`runtime-accepted` means the target runtime accepted the message into its supported input path. It does not prove the receiving model has already consumed the content.

ACS SHALL NOT synthesize an `agent-acknowledged` milestone merely from turn state, elapsed time, or a generic assistant response. Acknowledgement exists only when the receiving agent or runtime provides explicit message-specific evidence.

### Keep preemption behind a runtime-neutral capability

The application/domain layer depends on a harness-neutral interruption capability, for example:

```ts
interface RuntimeInterruptionCapabilities {
  interruptExecution: boolean;
  interruptOwnedExecutionOnly: boolean;
}
```

A runtime adapter maps this to its native primitive. For Codex, the implementation may use `turn/interrupt(threadId, turnId)` when the target execution can be identified and policy permits it.

The core MUST NOT branch on `runtime === "codex"` or expose Codex turn IDs outside the existing opaque runtime reference boundary.

### Preemption requires proven target ownership or explicit user-granted authority

Ordinary peer-message authority is insufficient to interrupt another agent's execution.

Before preemption, ACS MUST establish all of the following:

1. the target binding is current;
2. the target runtime execution is still active;
3. the adapter supports interruption;
4. the sender/principal has an explicit `message:preempt`-equivalent capability;
5. policy permits interruption of that execution class;
6. ACS can prove either that it owns an isolated managed execution or that the user explicitly granted authority to interrupt the target session.

If these conditions cannot be established, the preempt request is rejected or downgraded only if the caller explicitly allowed downgrade. ACS SHALL NOT silently turn a rejected preempt request into a normal message.

### Preemption is interrupt-then-deliver, not interrupt-as-delivery

For an authorized preempt request:

```text
preempt requested
  -> interrupt exact active execution
  -> observe accepted/not-running/unknown interruption outcome
  -> once the session is safely deliverable, submit the message through normal direct delivery
```

The peer message still travels through the ordinary provenance-preserving direct-delivery mechanism. `turn/interrupt` itself carries no peer message.

If interruption acceptance is ambiguous, ACS SHALL NOT immediately submit a replacement turn unless it can prove the runtime is in a safe state. The operation remains explicit and recoverable.

### Cancellation remains distinct from preemption

Canceling an A2A task does not imply permission to interrupt a shared/user-owned runtime turn. Message preemption and task cancellation are separate capabilities and audit events even if an implementation later offers a convenience workflow combining them.

### Priority is bounded

`high` priority SHOULD affect only ordering among pending/eligible delivery intents. The scheduler SHOULD include anti-starvation behavior so a sustained stream of high-priority messages cannot indefinitely block normal communication.

`preempt` SHOULD be rate-limited and auditable. Repeated preemption loops MUST be bounded by policy.

## Codex mapping

### Normal/high

Use the merged direct-delivery path:

```text
turn/start
  input: []
  toolOutput:
    namespace: acs
    name: receive_agent_message
    output: canonical delivery envelope
```

The adapter records the returned/observed turn and actual execution relationship where evidence permits.

### Preempt

When all authority and ownership checks pass:

```text
turn/interrupt(threadId, activeTurnId)
  -> await authoritative interruption result/state
  -> direct deliver using named toolOutput
```

No preemption capability is advertised until real-Codex tests establish the exact state transitions and ambiguous-write behavior for the pinned runtime profile.

## Specification governance

`openspec/specs` is the single normative source for ACS behavioral and architectural requirements. `openspec/changes` is the only place to propose changes to those requirements before they are archived into the canonical specs.

Other files may explain, illustrate, or implement the specification, but they do not create independent requirements:

- `contracts/` are typed implementation/wire contracts and must conform to OpenSpec;
- `docs/threat-model.md` may explain security analysis but normative security behavior belongs in OpenSpec;
- README and operator documentation describe usage and must conform to OpenSpec;
- `docs/adr/` becomes historical/non-normative material only.

### Retire ADRs without losing decisions

The existing ADRs should not be mechanically deleted before their useful content is audited. For each ADR:

1. identify still-valid behavioral or architectural requirements;
2. verify those requirements already exist in the relevant `openspec/specs` capability;
3. add missing requirements through this or a dedicated OpenSpec change;
4. mark the ADR historical/non-normative, move it under a clearly historical location, or remove it once its decision context is no longer useful.

No code review may rely on an ADR to override or supplement a canonical OpenSpec requirement. When an ADR and OpenSpec disagree, OpenSpec wins and the stale ADR should be corrected or retired.

ADR-009 is the immediate example: its safe-wake decision has been superseded by direct delivery. Its still-valid concerns—peer provenance, runtime capability evidence, local permission ownership, and ambiguous acceptance—must live in the canonical runtime-delivery/security specs rather than in a replacement ADR.

## Risks / Trade-offs

- **Normal messages may be observed late during tool-heavy turns** -> report runtime acceptance honestly; do not claim immediate observation.
- **High priority may still wait behind a long active execution** -> this is expected; high is non-destructive scheduling priority, not preemption.
- **Preemption can destroy useful work** -> require explicit authority, proven target identity, audit events, and bounded policy.
- **Interrupt succeeded but response was lost** -> reconcile runtime state before delivering a fresh turn; never blindly repeat interruption/delivery.
- **Runtime cannot expose message-specific acknowledgement** -> omit the milestone rather than infer it.
- **ADR retirement drops an undocumented invariant** -> audit every ADR before retirement and promote any unique normative content into OpenSpec first.

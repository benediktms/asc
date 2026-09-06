## ADDED Requirements

### Requirement: Delivery urgency is distinct from runtime interruption
ACS SHALL classify direct peer-message urgency as `normal`, `high`, or `preempt`. `normal` and `high` SHALL use non-interrupting direct delivery. `preempt` SHALL be treated as a separately authorized request to interrupt a runtime execution before direct delivery.

#### Scenario: Normal message targets a busy recipient
- **WHEN** a normal direct message is runtime-accepted while the recipient is executing tools
- **THEN** ACS records runtime acceptance without interrupting the execution or claiming the model has already observed the message

#### Scenario: High-priority message targets a busy recipient
- **WHEN** a high-priority message is eligible alongside normal pending deliveries
- **THEN** ACS may schedule the high-priority delivery first but does not interrupt the recipient's active execution

#### Scenario: Unauthorized preemption
- **WHEN** a caller requests `preempt` without explicit preemption authority or without a safely identifiable interruptible execution
- **THEN** ACS rejects the preemption request and does not silently downgrade it to normal delivery

### Requirement: Preemption is explicit interrupt-then-deliver
For an authorized `preempt` request, ACS SHALL interrupt only the exact runtime execution permitted by policy, wait for authoritative interruption state where available, and then submit the peer message through the ordinary direct-delivery path. Runtime interruption itself SHALL NOT carry or upgrade peer content.

#### Scenario: Authorized isolated execution
- **WHEN** ACS proves the target execution is active, interruptible, isolated or explicitly user-authorized, and the caller has preemption authority
- **THEN** ACS interrupts that execution and submits the peer message through normal direct delivery once the session is safely deliverable

#### Scenario: Interruption outcome is ambiguous
- **WHEN** an interruption request may have been accepted but ACS cannot prove the resulting runtime state
- **THEN** ACS does not immediately start replacement work and retains an explicit recoverable ambiguity state

### Requirement: Acceptance and observation milestones remain separate
ACS SHALL distinguish durable acceptance, runtime acceptance, explicit agent acknowledgement when available, and task reply/state transition. Runtime acceptance SHALL NOT be reported as proof that the model has read or acted on the message.

#### Scenario: Tool-heavy active turn
- **WHEN** the runtime accepts a peer message while the recipient remains inside long-running tool activity
- **THEN** ACS reports the message as runtime-accepted and leaves acknowledgement/reply unset until message-specific evidence exists

#### Scenario: Runtime lacks acknowledgement evidence
- **WHEN** the runtime provides no authoritative message-specific observation signal
- **THEN** ACS omits the acknowledgement milestone rather than inferring it from elapsed time, turn completion, or generic assistant output

### Requirement: Interruption is harness-neutral
Application and domain code SHALL express interruption through runtime-neutral capabilities and opaque execution references. Harness-specific operations such as Codex `turn/interrupt` SHALL remain inside the runtime adapter.

#### Scenario: Adapter lacks interruption support
- **WHEN** a runtime adapter reports no interruption capability and a caller requests preemption
- **THEN** ACS rejects the preemption request without branching on the harness identity in application/domain code

### Requirement: High priority is bounded
High-priority delivery scheduling SHALL include anti-starvation behavior, and preemption SHALL be rate-limited or otherwise bounded by policy.

#### Scenario: Sustained high-priority traffic
- **WHEN** high-priority messages continue to arrive while normal messages remain pending
- **THEN** the scheduler eventually services eligible normal traffic according to its anti-starvation policy

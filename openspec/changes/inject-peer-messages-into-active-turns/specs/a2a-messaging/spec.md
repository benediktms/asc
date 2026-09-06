## ADDED Requirements

### Requirement: Single direct delivery behavior
ACS SHALL expose one peer-message delivery behavior: `direct`. A2A delivery metadata and MCP send inputs SHALL NOT expose history append or wake policy selection.

#### Scenario: Caller sends a peer message
- **WHEN** an authorized caller submits a valid peer message without delivery metadata
- **THEN** ACS creates a direct delivery intent

#### Scenario: Caller requests a removed delivery mode
- **WHEN** a caller supplies `wake_when_idle`, `append_context`, or `join_active`
- **THEN** ACS rejects the unsupported mode without partially accepting the message

### Requirement: Runtime turn association does not define task result
A peer message/task MAY be accepted into a runtime turn that also contains other work. A2A task and reply semantics SHALL remain message/task-specific and SHALL NOT be inferred solely from runtime turn completion or final assistant output.

#### Scenario: Multiple peer tasks share one runtime turn
- **WHEN** two or more peer tasks are associated with one recipient runtime turn
- **THEN** each task retains its own state and reply correlation

#### Scenario: Runtime turn completes before explicit task completion
- **WHEN** a runtime turn completes but the recipient has not explicitly completed or failed an associated delegated task
- **THEN** ACS records runtime execution completion without terminally completing that A2A task

### Requirement: Explicit delegated-task terminal actions
All delegated tasks SHALL require an explicit, attested task-specific completion or failure operation, except cancellation transitions governed by the task state machine.

#### Scenario: Recipient completes a delegated task
- **WHEN** the attested recipient explicitly completes the task with a summary/artifacts
- **THEN** ACS transitions only that task to completed and emits its normal task event

#### Scenario: Recipient fails a delegated task
- **WHEN** the attested recipient explicitly fails the task
- **THEN** ACS transitions only that task to failed and emits its normal task event

## MODIFIED Requirements

### Requirement: Atomic durable acceptance
ACS SHALL atomically commit the task, message, append-only event, idempotency record, and direct delivery intent before reporting durable acceptance. Runtime acceptance SHALL be tracked separately and, when accepted, SHALL record the recipient session and accepting turn evidence plus the runtime-reported execution relationship (`started`, `joined`, or `unknown`) where available.

#### Scenario: Acceptance write fails
- **WHEN** any write in message acceptance fails
- **THEN** no partial acceptance is committed

#### Scenario: Duplicate message
- **WHEN** an equivalent request repeats an accepted idempotency identity
- **THEN** ACS returns the existing task without creating a duplicate delivery

#### Scenario: Runtime has not accepted the message
- **WHEN** durable acceptance succeeds but direct runtime delivery is still pending
- **THEN** ACS reports the task as durably accepted without claiming that the recipient session received it

#### Scenario: Runtime accepts into an existing turn
- **WHEN** direct delivery is accepted into an already-active runtime turn
- **THEN** ACS records runtime acceptance for that delivery against the existing turn without creating a second A2A task or inferring a completed result

### Requirement: Cancellation does not imply shared-turn interruption
A requester cancellation SHALL cancel the target A2A task/delivery according to the task state machine. ACS SHALL NOT automatically interrupt a runtime turn merely because the canceled task has a delivery associated with that turn.

#### Scenario: Canceled task shares a turn
- **WHEN** a requester cancels a task whose peer message was accepted into a turn containing other work
- **THEN** ACS records task cancellation without interrupting the shared turn unless isolated runtime ownership is separately proven

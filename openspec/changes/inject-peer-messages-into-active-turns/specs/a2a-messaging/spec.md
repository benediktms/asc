## ADDED Requirements

### Requirement: Single direct delivery behavior
ACS SHALL expose one peer-message delivery behavior: `direct`. A2A delivery metadata and MCP send inputs SHALL NOT expose history append or wake policy selection.

#### Scenario: Caller sends a peer message
- **WHEN** an authorized caller submits a valid peer message without delivery metadata
- **THEN** ACS creates a direct delivery intent

#### Scenario: Caller requests a removed delivery mode
- **WHEN** a caller supplies `wake_when_idle`, `append_context`, or `join_active`
- **THEN** ACS rejects the unsupported mode without partially accepting the message

## MODIFIED Requirements

### Requirement: Atomic durable acceptance
ACS SHALL atomically commit the task, message, append-only event, idempotency record, and direct delivery intent before reporting durable acceptance. Runtime acceptance SHALL be tracked separately and SHALL identify the exact existing or newly started target turn when accepted.

#### Scenario: Acceptance write fails
- **WHEN** any write in message acceptance fails
- **THEN** no partial acceptance is committed

#### Scenario: Duplicate message
- **WHEN** an equivalent request repeats an accepted idempotency identity
- **THEN** ACS returns the existing task without creating a duplicate delivery

#### Scenario: Runtime has not accepted the message
- **WHEN** durable acceptance succeeds but direct runtime delivery is still pending
- **THEN** ACS reports the task as durably accepted without claiming that the recipient turn received it


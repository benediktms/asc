# A2A messaging

## Purpose

Define durable inter-agent messaging independently of runtime execution.
See ADRs 002, 006, and 008 and `contracts/a2a-application-port.ts`.

## Requirements

### Requirement: A2A data plane

ACS SHALL use A2A JSON-RPC for inter-agent messaging and expose Agent Cards and
task send, get, list, and cancel operations. The private control protocol SHALL
NOT provide a general-purpose inter-agent send operation.

#### Scenario: Authenticated message

- **WHEN** an authorized agent submits a valid message to an enabled target
- **THEN** ACS returns the durably accepted task through the A2A interface

### Requirement: Atomic durable acceptance

ACS SHALL commit the task, message, append-only event, idempotency record, and
delivery intent atomically before reporting durable acceptance. Runtime
acceptance SHALL be tracked separately.

#### Scenario: Acceptance write fails

- **WHEN** any write in message acceptance fails
- **THEN** no partial acceptance is committed

#### Scenario: Duplicate message

- **WHEN** an equivalent request repeats an accepted idempotency identity
- **THEN** ACS returns the existing task without creating a duplicate delivery

### Requirement: Bounded input and admission

ACS SHALL enforce configured request and message-part limits, authenticate
callers, and reject delivery admission when the queue is full.

#### Scenario: Queue capacity reached

- **WHEN** a message arrives at a target whose delivery admission is full
- **THEN** ACS rejects it without partial persistence and returns HTTP 429

### Requirement: Durable task history

ACS SHALL preserve append-only task events and update the materialized task
snapshot in the same transaction.

#### Scenario: Restart after acceptance

- **WHEN** the daemon restarts after an acceptance transaction commits
- **THEN** the accepted task and its pending delivery remain available

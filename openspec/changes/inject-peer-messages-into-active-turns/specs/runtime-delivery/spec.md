## ADDED Requirements

### Requirement: Direct turn delivery
ACS SHALL deliver each peer message directly to a reachable recipient turn. When the recipient has a steerable active turn, ACS SHALL inject the canonical delivery envelope into that turn as untrusted additional context using the active turn identifier as a precondition. When the recipient is idle, ACS SHALL start a turn with the envelope as named tool output. ACS SHALL NOT use history-only context append as a delivery fallback.

#### Scenario: Recipient has a steerable active turn
- **WHEN** a direct delivery targets a reachable recipient with an active steerable turn
- **THEN** ACS injects the message into that exact turn and records runtime acceptance against that turn

#### Scenario: Recipient is idle
- **WHEN** a direct delivery targets a reachable idle recipient
- **THEN** ACS starts one turn containing the message as named tool output and records the new turn identifier

#### Scenario: Active turn changed before injection
- **WHEN** the active turn no longer matches the turn ACS inspected
- **THEN** ACS does not inject into a different turn and keeps the delivery pending for a fresh attempt

#### Scenario: Active turn cannot be steered
- **WHEN** the runtime rejects direct injection because the current turn is non-steerable
- **THEN** ACS keeps the delivery pending until a later direct attempt is safe

#### Scenario: Recipient runtime route is unavailable
- **WHEN** ACS cannot reach the app-server that owns the recipient thread
- **THEN** ACS keeps the delivery pending and does not append it to history or require inbox polling as successful delivery

### Requirement: Shared-turn task correlation
ACS SHALL allow multiple direct deliveries to reference one active turn without treating that turn's final output as the result of every task. A task injected into an already-running turn SHALL require an explicit task completion, failure, or input request from the recipient.

#### Scenario: Several peer messages enter one active turn
- **WHEN** two or more tasks are injected into the same active turn
- **THEN** ACS records each delivery separately and does not automatically complete any of those tasks from the shared final message

#### Scenario: ACS starts a dedicated turn
- **WHEN** ACS starts an idle recipient turn for one task
- **THEN** the correlated final output may complete that task under the existing reply policy

## MODIFIED Requirements

### Requirement: Untrusted peer provenance
ACS SHALL deliver peer content as untrusted runtime context. Active-turn delivery SHALL use runtime-native untrusted additional context, and an ACS-started turn SHALL use named tool output. ACS SHALL NOT forge user, developer, or system messages or treat peer content as permission to act.

#### Scenario: Peer message enters an active turn
- **WHEN** ACS injects a peer message into an active turn
- **THEN** the runtime receives the canonical envelope with untrusted provenance and no user input item is fabricated

#### Scenario: Peer requests privileged action
- **WHEN** a peer message contains instructions requesting permission or approval
- **THEN** the content remains untrusted and ACS grants no permission

### Requirement: Ambiguous acceptance is not blindly retried
A flushed direct-delivery request whose response is lost SHALL enter `acceptance-unknown`. ACS SHALL reconcile acceptance only from authoritative evidence containing the exact delivery marker and target turn. When available history cannot prove acceptance or absence, ACS SHALL require audited operator resolution and SHALL NOT automatically resend the delivery.

#### Scenario: Exact active-turn marker is found
- **WHEN** reconciliation finds the delivery marker in the expected target turn
- **THEN** ACS records the delivery as accepted against that turn without sending it again

#### Scenario: Runtime history is inconclusive
- **WHEN** authoritative runtime evidence cannot prove whether direct delivery was accepted
- **THEN** ACS leaves the delivery in `acceptance-unknown` for audited operator resolution

#### Scenario: Context-only delivery has no history marker
- **WHEN** a legacy context-only attempt enters `acceptance-unknown` during migration and has no authoritative history marker
- **THEN** ACS does not automatically resend or convert that attempt

## REMOVED Requirements

### Requirement: Capability and policy controlled wake
**Reason**: Separate history append and wake policies delay messages and prevent an already-running recipient from seeing peer communication during its active turn.

**Migration**: Replace `wake_when_idle`, `append_context`, `join_active`, and per-binding non-atomic wake policy with direct delivery. Existing pending intents are migrated to direct delivery while preserving identity, binding epoch, attempt history, and idempotency data.

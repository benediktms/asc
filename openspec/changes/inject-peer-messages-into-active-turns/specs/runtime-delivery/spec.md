## ADDED Requirements

### Requirement: Direct session delivery
ACS SHALL deliver each peer message directly to the reachable bound runtime session using a runtime-native active-input mechanism. For Codex, ACS SHALL submit the canonical delivery envelope as named tool output with empty local-user input. When the recipient is idle, the runtime MAY start a new turn; when the runtime accepts the input into an already-active supported turn, ACS SHALL record that existing turn. ACS SHALL NOT use history-only context append as a delivery fallback.

#### Scenario: Recipient is idle
- **WHEN** a direct delivery targets a reachable idle recipient
- **THEN** ACS submits the peer message through native named tool output and records the new accepting turn identifier

#### Scenario: Recipient has an active supported turn
- **WHEN** a direct delivery targets a reachable recipient whose runtime accepts peer input into the current active turn
- **THEN** ACS records runtime acceptance against that active turn without pretending ACS owns a new turn

#### Scenario: Runtime reports an unknown start-or-join relationship
- **WHEN** the runtime accepts the direct input and returns a turn identifier but cannot prove whether the delivery started or joined the turn
- **THEN** ACS records runtime acceptance with execution relationship `unknown` rather than inferring `started`

#### Scenario: Active runtime state cannot accept direct input
- **WHEN** the recipient runtime rejects direct input in the current state
- **THEN** ACS keeps the delivery pending for a later direct attempt and does not append the message to history

#### Scenario: Recipient is blocked on local input or approval
- **WHEN** the runtime reports that the recipient is awaiting locally-owned approval, authentication, or user input and direct delivery is not safe
- **THEN** ACS keeps the delivery pending or reports the precise blocked state and does not answer, deny, or bypass the local request

#### Scenario: Recipient runtime route is unavailable
- **WHEN** ACS cannot reach the app-server/runtime control plane that owns the recipient session
- **THEN** ACS keeps the delivery pending and does not append it to history or require inbox polling as successful delivery

### Requirement: Peer provenance is preserved
ACS SHALL deliver peer content through a runtime representation that preserves external/peer authority. ACS SHALL NOT fabricate local user, developer, or system input solely to make direct delivery succeed.

#### Scenario: Codex peer message is delivered
- **WHEN** ACS submits a peer message to Codex
- **THEN** the canonical delivery envelope is represented as named tool output under the ACS namespace and no local `UserInput` item is fabricated

#### Scenario: Peer requests privileged action
- **WHEN** peer content asks the recipient to approve or authorize an operation
- **THEN** ACS grants no permission and the recipient runtime retains its own local approval policy

### Requirement: Unsupported context-only steering is not used
ACS SHALL NOT use Codex `turn/steer` with empty input and `additionalContext` as its peer-message delivery path for a Codex profile whose upstream behavior rejects context-only steering. ACS SHALL NOT add fake user input to work around that rejection.

#### Scenario: Pinned Codex profile rejects empty-input steering
- **WHEN** compatibility evidence shows `turn/steer` with empty `input` and context-only peer data is rejected
- **THEN** ACS uses the supported native named-tool-output direct-delivery path instead and records exact-turn conditional steering as unsupported for that profile

### Requirement: Shared-turn task correlation
ACS SHALL allow multiple direct deliveries to reference one runtime turn without treating that turn's final output as the result of every task. Each delivery SHALL retain its own message/task identity and reply contract.

#### Scenario: Several peer messages enter one active turn
- **WHEN** two or more peer messages/tasks are accepted into the same runtime turn
- **THEN** ACS records each delivery separately and preserves independent reply/task correlation

#### Scenario: Shared turn produces a final assistant response
- **WHEN** a runtime turn associated with multiple peer deliveries completes
- **THEN** ACS records the runtime output but does not automatically attribute that response as the result of every associated task

### Requirement: Runtime completion does not imply task completion
A delegated A2A task SHALL enter a terminal completed or failed state only through an explicit task-specific operation or requester cancellation semantics. Runtime `turn/completed` SHALL NOT automatically complete a delegated task, even when the task's first delivery started the runtime turn.

#### Scenario: ACS-started turn completes
- **WHEN** a peer task delivery causes Codex to start a new turn and that turn later completes
- **THEN** ACS records the runtime execution as completed but leaves the A2A task non-terminal until the recipient explicitly completes, fails, or requests further input on that task

#### Scenario: Recipient explicitly completes the task
- **WHEN** the attested recipient calls the task-completion operation for that task
- **THEN** ACS transitions that task according to the task state machine independently of the runtime turn lifecycle

### Requirement: Task cancellation is isolated from shared-turn interruption
Canceling a peer task SHALL NOT automatically interrupt a runtime turn that may contain local work or other peer tasks. Runtime interruption is permitted only when ACS can prove isolated execution ownership and policy explicitly allows interruption.

#### Scenario: Cancel one task sharing a runtime turn
- **WHEN** the requester cancels one peer task whose delivery is associated with a turn containing other work
- **THEN** ACS changes the task/delivery cancellation state without interrupting the shared runtime turn

#### Scenario: Isolated ACS-owned execution is cancelable
- **WHEN** ACS can prove the runtime execution is isolated to the canceled work and interruption is authorized
- **THEN** the runtime adapter MAY interrupt that execution and record the runtime cancellation evidence

## MODIFIED Requirements

### Requirement: Ambiguous acceptance is not blindly retried
A flushed direct-delivery request whose response is lost SHALL enter `acceptance-unknown`. ACS SHALL reconcile acceptance only from authoritative runtime evidence containing the exact delivery marker and target session/turn evidence available for the selected runtime profile. When available evidence cannot prove acceptance or non-acceptance, ACS SHALL require audited operator resolution and SHALL NOT automatically resend the delivery.

#### Scenario: Exact delivery marker is found
- **WHEN** reconciliation finds authoritative evidence for the exact delivery marker and payload identity in the recipient runtime
- **THEN** ACS records the delivery as accepted against the evidenced turn without sending it again

#### Scenario: Runtime evidence proves non-acceptance
- **WHEN** the runtime provides authoritative evidence that the flushed direct request was not accepted
- **THEN** ACS MAY return the delivery to a retryable pending state if policy permits

#### Scenario: Runtime evidence is inconclusive
- **WHEN** authoritative runtime evidence cannot prove whether direct delivery was accepted
- **THEN** ACS leaves the delivery in `acceptance-unknown` for audited operator resolution

## REMOVED Requirements

### Requirement: Capability and policy controlled wake
**Reason**: Separate history append and wake policies delay messages and prevent an already-running recipient from seeing peer communication during its active session.

**Replacement**: Use one direct native session-delivery behavior. Runtime-specific adapters report whether the accepted input started, joined, or has an unknown relationship to the accepting runtime turn.

### Requirement: Legacy delivery-mode migration
**Reason**: ACS has not been deployed and has no compatibility obligation for unused delivery-mode state.

**Replacement**: Update the initial storage schema, fixtures, contracts, configuration, and tests directly to the direct-delivery model.

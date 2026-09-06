## ADDED Requirements

### Requirement: Docker remains an optional backend

The production spawning design SHALL retain a direct Codex app-server path
without requiring Docker Agent, Docker Engine, Docker Desktop or Docker
Sandboxes. Adding an optional backend SHALL NOT change the behavior of attached
agents or silently migrate existing bindings.

#### Scenario: Docker tooling is absent

- **WHEN** an operator uses the supported direct Codex spawning profile without Docker tooling installed
- **THEN** the operation does not depend on Docker tooling
- **AND** Docker-specific profiles remain unavailable rather than replacing the selected profile

### Requirement: Profile-controlled separation of concerns

ACS SHALL distinguish the harness adapter, execution environment and workspace
provisioner in operator-owned, versioned profiles. ACS SHALL validate the
combination and caller authority before external effects. The core SHALL use
opaque references rather than vendor commands or SDK types. A spawning agent
SHALL NOT supply unrestricted commands, images, mounts, network policy or secrets.

#### Scenario: Requested profile requires unsupported workspace behavior

- **WHEN** a profile requires in-agent Git operations but its workspace/environment combination cannot provide them
- **THEN** admission rejects the request before creating an environment or runtime session
- **AND** ACS does not broaden filesystem access to make the combination work

### Requirement: ACS identity and task authority are retained

A backend session or background job SHALL NOT become an ACS principal merely
because it has an identifier. Registration SHALL establish the logical agent,
origin, active binding, epoch and bound principal using the reviewed atomic
registration boundary. Peer A2A acceptance, runtime execution acceptance and
backend lifecycle state SHALL remain distinct. Origin SHALL NOT impose a
parent-mediated message route or automatic lifetime cascade.

#### Scenario: Backend returns a child session identifier

- **WHEN** a backend creates a child session but trusted caller identity and binding registration are not established
- **THEN** ACS does not expose it as a registered peer or grant another agent's authority

### Requirement: Environment and runtime effects are independently recoverable

ACS SHALL record intent, ownership and attempts separately for workspace,
environment, runtime session and binding effects. A lost response after a
possible write SHALL enter reconciliation rather than be blindly replayed.
Lookup or idempotency evidence SHALL apply to the exact operation being
reconciled. Environment discovery SHALL NOT prove session creation.

#### Scenario: Sandbox exists but thread creation is ambiguous

- **WHEN** reconciliation finds the owned sandbox but cannot identify the thread created by the recorded start attempt
- **THEN** the thread start remains reconciliation-required
- **AND** ACS neither guesses a binding nor starts a replacement thread automatically

#### Scenario: Follow-up deduplication is the only proven idempotency feature

- **WHEN** a backend guarantees deduplication for follow-up messages but not session creation
- **THEN** ACS does not use that guarantee to retry an ambiguous session creation

### Requirement: Existing permission ownership is preserved

An execution backend SHALL preserve the existing runtime-delivery requirements
for local approvals, user input, untrusted peer provenance and owned
cancellation. This change SHALL NOT authorize approval bypass or weaken an
existing sandbox policy. A backend whose launcher cannot express the approved
profile SHALL remain disabled for that profile. An autonomous policy exception
requires a separate reviewed specification change and conformance evidence.

#### Scenario: Launcher always disables Codex approvals and sandboxing

- **WHEN** the selected launcher unconditionally disables controls required by the approved profile
- **THEN** ACS rejects that combination rather than treating external isolation as implicit authorization

### Requirement: Cross-environment transport is scoped and authenticated

A cross-environment integration SHALL establish trusted runtime connectivity and
per-binding ACS caller attestation independently. It SHALL NOT expose operator
credentials or an unscoped ACS administration endpoint to a worker. Missing
connectivity SHALL NOT be repaired by sharing the host Docker socket, mounting
the whole home directory or publishing an unauthenticated control service.
Credentials and authentication material SHALL NOT enter lifecycle telemetry.

#### Scenario: MCP is reachable but the runtime control plane is not

- **WHEN** a sandboxed session can call its scoped ACS tools but ACS cannot reach the session through its reviewed runtime adapter
- **THEN** ACS does not report automatic runtime delivery as available
- **AND** it does not resume a second copy of that active session to bypass the failure

### Requirement: Capability claims require versioned evidence

Backend capabilities SHALL be enabled only for a reviewed combination of runtime
version, protocol, execution profile and platform with conformance evidence.
Unsupported behavior SHALL remain explicitly unsupported. A2A advertisement,
stored history or an event stream alone SHALL NOT establish ACS compatibility,
child-process survival or noninterrupting context delivery.

#### Scenario: Only preemptive steering is available

- **WHEN** a backend can inject a message only by interrupting the active turn
- **THEN** ACS does not advertise that operation as noninterrupting context delivery
- **AND** any interruption remains subject to ACS ownership and authorization rules

### Requirement: Cleanup preserves all unexported work

Stopping a worker SHALL NOT imply deleting its environment or workspace.
Destructive cleanup SHALL require explicit authority, proven ownership, verified
retention/export of work and no remaining live users of the resource. Existing
paths, dirty or ambiguous workspaces, and sandbox-local work without verified
export SHALL be retained for operator resolution. A clean Git status alone
SHALL NOT prove that commits are preserved outside a disposable environment.

#### Scenario: Clean clone contains commits that exist only inside the sandbox

- **WHEN** cleanup finds a clean working tree but cannot prove that sandbox-local commits have been exported or retained
- **THEN** ACS retains the environment as cleanup-required
- **AND** it does not remove the environment merely because the agent's task completed

#### Scenario: Multiple agents share an environment

- **WHEN** one agent stops while other registered agents still use the same environment
- **THEN** ACS does not terminate that environment as a side effect of stopping the one agent

### Requirement: Resource accounting covers physical environments

Admission SHALL reserve agent capacity and any required environment capacity
without conflating logical sessions with isolated processes or VMs. A profile
requiring enforceable resource limits SHALL be rejected when the selected
backend cannot enforce them. Ambiguous or unproven termination SHALL NOT silently
release reservations; audited operator resolution remains available.

#### Scenario: Environment disappears from a transient list response

- **WHEN** an environment is temporarily absent from discovery but termination is unproven
- **THEN** ACS retains its reservation pending authoritative reconciliation or audited operator resolution

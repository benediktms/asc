# Runtime-neutral agent spawning (WIP specification)

Status: research result for #13; not a production API

This specification describes a lifecycle control plane that can create runtime
sessions and register them as ordinary ASC agents. It does not change A2A: once
registered, a spawned agent has the same addressability and peer communication
rules as an attached agent. Origin is metadata, not hierarchy.

## Recommendation

Add three independently authorized application ports:

1. a runtime-neutral lifecycle port for session creation, inspection and stop;
2. a workspace provisioner port that resolves a workspace request to a local
   path and owns cleanup checks;
3. a spawn application service that durably coordinates policy, workspace,
   runtime and registration as a recoverable saga.

Keep the existing runtime delivery adapter and A2A application port unchanged.
Lifecycle state, runtime availability and A2A task state are orthogonal. A
convenience command may spawn and then delegate, but it creates separate spawn
and A2A task records.

The proposed TypeScript port is in
[`contracts/runtime-lifecycle.ts`](../contracts/runtime-lifecycle.ts). Version
zero means research-only. No production package imports it in this spike.

## Boundaries

| Concern                                           | Owner                     | Portable representation                             |
| ------------------------------------------------- | ------------------------- | --------------------------------------------------- |
| admission, quota and durable desired state        | ASC spawn service         | spawn request and policy snapshot                   |
| workspace materialization and cleanup eligibility | workspace provisioner     | opaque provisioner request and managed workspace ID |
| process/thread operations                         | runtime lifecycle adapter | installation and opaque session references          |
| logical agent, binding epoch and agent principal  | ASC registration          | existing agent/binding records                      |
| peer work and results                             | A2A                       | existing task/message/event records                 |
| idle, busy and local-input state                  | runtime delivery adapter  | existing runtime availability                       |

The core must not contain `codexThreadId`, Codex permission enums, Git branch
names, or app-server request types. Runtime and workspace-specific options are
validated by the selected adapter/provisioner before any side effect.

## State model

ASC owns a durable desired state and saga state. Runtime state is an observed
projection; `idle` and `working` remain delivery/execution observations rather
than lifecycle states.

| ASC saga state                       | Durable meaning                                    | Permitted next states                                        |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| `requested`                          | request and immutable inputs recorded              | `admitted`, `rejected`                                       |
| `admitted`                           | policy/quota reservation committed                 | `provisioning`, `failed`                                     |
| `provisioning`                       | workspace intent exists                            | `runtime-start-pending`, `failed`, `reconciliation-required` |
| `runtime-start-pending`              | spawn attempt exists; write may occur              | `binding-pending`, `failed`, `reconciliation-required`       |
| `binding-pending`                    | runtime session identity is proven                 | `registered`, `reconciliation-required`                      |
| `registered`                         | agent, active binding and principal are committed  | `stop-requested`                                             |
| `stop-requested`                     | no new task admission; runtime stop/detach pending | `cleanup-pending`, `reconciliation-required`                 |
| `cleanup-pending`                    | binding revoked; workspace retained until checked  | `terminated`, `cleanup-required`                             |
| `cleanup-required`                   | operator decision is required                      | `cleanup-pending`, `terminated`                              |
| `reconciliation-required`            | an external effect is possible but unproven        | any proven successor or `failed` by operator decision        |
| `terminated` / `rejected` / `failed` | terminal outcome                                   | none                                                         |

Each transition is a compare-and-swap on a monotonically increasing generation.
Only one worker may hold the spawn lease. A terminal runtime observation never
silently deletes the logical agent or workspace.

### Recovery rules

- Before every external effect, persist an attempt row and set its state to
  `writing`. Mark it flushed immediately after the transport confirms the write.
- If the operation is known not to have been written, retry with the same ASC
  request ID.
- If it may have been written and the runtime has no proven idempotency or lookup
  key, transition to `reconciliation-required`; do not retry.
- A proven runtime session without a binding resumes at `binding-pending`.
- A binding transaction failure leaves the proven session referenced by the
  spawn record so an operator can bind or explicitly detach it.
- On restart, lease expiry makes work eligible for reconciliation, not blind
  replay. Registered agents survive coordinator termination; there is no default
  parent-to-child cascade.
- Runtime disappearance marks its projection `unknown`/`offline`. It does not
  release quota until the lifecycle policy proves termination or an operator
  resolves it.

## Persistence proposal

Add these tables in the implementation phase:

- `spawn_requests`: request ID, desired state, saga state/generation, logical
  agent ID, origin metadata, installation/profile, policy snapshot, workspace
  request hash, session reference when proven, timestamps and redacted error;
- `spawn_attempts`: request ID, operation, attempt number, lease, write state,
  runtime evidence and outcome;
- `managed_workspaces`: provisioner ID, opaque workspace ID, resolved path,
  ownership, baseline identity, cleanup policy/state and last cleanliness check;
- `agent_origins`: agent ID, `attached|spawned`, spawn request and optional
  requesting agent/binding IDs;
- `lifecycle_events`: append-only transition records with correlation IDs.

The admission transaction inserts the request, snapshots policy, and reserves a
quota slot. Logical agent creation may occur in that transaction or immediately
before binding, but registration must atomically commit the agent (if new),
origin, active binding and bound-agent principal. The existing `Store.bind`
transaction already proves binding/principal atomicity; a production method
should extend that boundary rather than compose `createAgent` and `bind` as the
prototype does.

Request IDs are idempotent only inside ASC. Reusing one with different canonical
inputs is a conflict. Sensitive runtime options are stored as a hash plus a
reviewed, redacted policy snapshot; prompts, tokens and approval contents are
not lifecycle telemetry.

## Codex mapping

| Neutral operation           | Current supported Codex primitive                                              | Confidence and consequence                                                               |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| spawn                       | app-server `thread/start` with an explicit `cwd` and reviewed start parameters | supported by the generated 0.153.2 boundary and existing client                          |
| session identity            | `thread/start` response `thread.id`                                            | proven on a successful response                                                          |
| inspect session             | `thread/read`; list/loaded-list for discovery                                  | supported, but discovery is not proof of spawn ownership                                 |
| make dormant session active | `thread/resume`                                                                | supported as a load operation; interactive ownership is not implied                      |
| observe work                | notifications plus `thread/read`                                               | existing delivery-adapter concern                                                        |
| stop safely                 | revoke/detach the ASC binding                                                  | portable recommendation                                                                  |
| destroy runtime history     | `thread/delete`                                                                | method exists; retention/resume semantics are not sufficiently evidenced for default use |

`thread/start` is the best supported creation primitive. Starting another TUI
process is not required to create a thread and would couple lifecycle to an
interactive frontend. It may still be useful as a local owner for approval or
input requests, but clean later attachment to an ASC-created thread is unknown.

The generated Codex schema exposes more start settings than ASC's currently
reviewed anti-corruption DTO. Production support should expose only named,
versioned runtime profiles. A profile expands inside the Codex adapter to model,
reasoning, sandbox/permission profile, approval routing, MCP/config and history
settings. The caller may select an allowed profile and a small reviewed override
set; it must not send arbitrary Codex config through the neutral contract.

Do not inherit a coordinator's settings implicitly. Inheritance could silently
launder sandbox, network, approval or MCP authority. The safe default is an
operator-defined profile, explicit workspace, least privilege, and local review
for anything outside that profile. `approvalPolicy: never` must never be chosen
just to make a headless worker progress.

### Codex ambiguity

No reviewed `thread/start` field provides an idempotency key or a lookup key for
the ASC spawn request. If the request was written and its response is lost, ASC
cannot prove which newly listed thread (if any) belongs to the request. Matching
by cwd, time, name or preview is advisory only. The adapter must return
`unknown`, quarantine candidate sessions from automatic binding, and require an
operator decision. Automatic retry risks two live agents.

The prototype maps an existing workspace and the reviewed `approvalPolicy`,
`sandbox` and `ephemeral` subset to `thread/start`. It deliberately reports stop
and inspection as unsupported rather than filling evidence gaps.

### Shared app-server consequences

The foundation work in #1/#4 shows that an ASC client sharing an app-server does
not own server-initiated approvals or local input. ASC never answers those
requests and unknown methods fail closed. Therefore successful spawning does not
mean the agent can run unattended. A spawned turn may pause in
`awaiting-local-input` until an authorized local owner responds.

A dedicated app-server is appropriate when isolation of subscriptions,
settings, credentials or lifecycle ownership is required, but isolation alone
does not grant ASC permission to answer server requests. Whether one process can
safely host multiple spawned threads across restart, and whether a TUI can later
attach without changing ownership, remain compatibility-profile evidence gates.

## Workspace design

The neutral lifecycle request names either an existing path or a provisioner and
opaque request. A separate `WorkspaceProvisioner` should implement `provision`,
`inspect`, and `prepareCleanup`; Git is one implementation. Multi-repository
work is explicit: the coordinator supplies one workspace request per agent.
Automatic repository discovery is deferred.

For Git worktrees, the provisioner should:

1. resolve the repository and base commit before admission and enforce allowed
   roots using canonical paths;
2. reserve a unique managed path and branch/ref intent durably;
3. run `git worktree add` without shell interpolation;
4. record repository identity, baseline commit and worktree registration;
5. on cleanup, check Git registration, tracked changes, untracked files and
   unexpected nested repositories;
6. return `cleanup-required` if anything is dirty, ambiguous or outside the
   managed root.

Cleanup is explicit. Stop first revokes the binding and leaves the workspace.
Only a separately authorized cleanup request may remove a proven clean,
ASC-managed worktree. Existing and non-Git paths are never removed. `--force`
is not an automated recovery mechanism; dirty work is preserved for inspection.

## Authorization and resource policy

`a2a:send` does not imply spawn authority. Use separate capabilities:

- `spawn:request`: submit a request subject to policy;
- `spawn:execute`: run provisioner/runtime effects (service worker only);
- `spawn:inspect`: view lifecycle metadata;
- `spawn:stop`: request detach/termination;
- `workspace:cleanup`: authorize a separate cleanup decision.

Policy is evaluated and snapshotted at admission. Enforce concurrent slots,
maximum total live agents, maximum origin depth, allowed installation/profile,
allowed workspace roots, and optionally per-origin/task budgets. Quota
reservation must be atomic with admission. A request for five agents with three
slots produces three accepted request IDs and two explicit resource-limit
rejections; it must not silently queue or partially report success.

Default depth is one, recursive spawn is off, coordinator termination does not
cascade, and capacity is released only after termination is proven. An agent
principal may request spawn only when an operator has granted `spawn:request`;
the privileged ASC worker executes it.

## Proposed user workflow

MCP and CLI return durable request records immediately:

```text
acs_agent_spawn(name, runtimeProfile, workspace, task?) ->
  { spawnRequestId, agentId?, state, taskId? }
acs_agent_status(spawnRequestId)
acs_spawned_agents_list(originAgentId?)
acs_agent_stop(agentId, disposition="detach")
```

```sh
acs agents spawn payments --runtime-profile codex-safe-worker --workspace /repos/payments
acs agents spawn payments --runtime-profile codex-safe-worker \
  --provisioner git-worktree --repo /repos/payments --base-ref main
acs agents status <spawn-request-id>
acs agents stop payments --detach
acs workspaces cleanup <managed-workspace-id>
```

If `task` is provided, the service persists a normal A2A send intent linked to
the spawn request and submits it only after `registered`. Task failure does not
roll back a live agent; spawn failure marks the handoff failed without creating
an A2A task. The standalone spawn and A2A send operations remain available.

## Observability

Emit `spawn.requested`, `spawn.admitted`, `workspace.provisioning`,
`workspace.ready`, `runtime.spawn.write_started`, `runtime.spawn.ready`,
`binding.created`, `spawn.reconciliation_required`, `spawn.failed`,
`agent.stop.requested`, `runtime.terminated`, and
`workspace.cleanup_required`. Include spawn request, lifecycle attempt, agent,
binding epoch, installation, provisioner, policy revision and trace IDs. Exclude
prompts, tokens, absolute paths by default, approval content and arbitrary
runtime option values. Metrics should cover state counts, admission rejection,
stage latency, ambiguity, orphan candidates and retained workspaces.

## Prototype result

Run:

```sh
bun test tests/runtime-spawn-spike.test.ts
```

The test executes the proposed Codex adapter mapping against a deterministic
`thread/start` double, creates two logical agents and binding principals in the
real SQLite store, and sends A2A tasks directly in both directions through the
real ASC application port. This proves the composition boundary and peer
semantics. It does not prove a live Codex model turn, process supervision,
worktree commands, crash recovery or production transactionality.

## Explicit unknowns

- whether `thread/start` will gain a stable idempotency/correlation field;
- reliable identification of an orphan after an ambiguous start response;
- whether and how a TUI can attach to an ASC-created thread while preserving
  request, MCP, settings and current-turn ownership;
- exact `thread/delete` history, archival and resumability semantics;
- process-level supervision and credential scope for a dedicated app-server;
- whether multiple spawned threads on one app-server have independent settings,
  MCP configuration and approval routing across all supported builds;
- which start fields remain stable enough for each compatibility profile;
- runtime behavior when the creating client disconnects during or after start.

These remain fail-closed compatibility gates. The spike does not turn them into
production capabilities.

## Implementation sequence

Follow-up tickets should be implemented in this dependency order:

1. freeze lifecycle and workspace port contracts;
2. add lifecycle persistence, leases and reconciliation transitions;
3. add spawn authorization and transactional quota reservation;
4. implement workspace provisioner abstraction, then Git worktrees;
5. implement Codex start/inspect/detach against compatibility profiles;
6. integrate atomic logical-agent/origin/binding registration;
7. add lifecycle telemetry and operator diagnostics;
8. expose MCP and CLI lifecycle operations;
9. add optional initial A2A task handoff;
10. validate crash/orphan recovery and multi-agent end-to-end behavior;
11. publish the user/operator workflow.

The implementation backlog is now recorded as #21 through #34:

| Issue | Implementation unit                              |
| ----- | ------------------------------------------------ |
| #21   | runtime lifecycle and workspace port contracts   |
| #22   | spawn saga persistence and reconciliation state  |
| #23   | spawn authorization and quotas                   |
| #24   | workspace provisioner abstraction                |
| #25   | Git worktree provisioning and safe retention     |
| #26   | Codex lifecycle adapter                          |
| #27   | atomic logical-agent/origin/binding registration |
| #28   | lifecycle observability and diagnostics          |
| #29   | MCP lifecycle tools                              |
| #30   | CLI lifecycle commands                           |
| #31   | spawn-and-delegate A2A handoff                   |
| #32   | crash, restart and orphan recovery tests         |
| #33   | five-agent end-to-end validation                 |
| #34   | final operator documentation                     |

Each issue references this spike and carries its exact cross-ticket
dependencies.

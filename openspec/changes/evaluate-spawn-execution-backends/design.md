## Context

Research date: 2026-09-06. This is a source/documentation assessment, not a live
compatibility result or benchmark. Docker Agent source was inspected at
`5683379ca3518397174acc12a19d32e0ffb1a515`; its pinned `rumpl/harness`
dependency was inspected at `9376b9c76461`. These are reviewed revisions, not a
claim about the latest stable release. Documentation is rolling and must be
rechecked against the binaries selected for a spike.

ACS main uses a reviewed Codex app-server boundary, host-attested MCP identity,
binding epochs, and durable A2A records. An MCP connection alone does not prove
that the shared app-server hosts the session. The existing runtime-spawn spike
uses a deterministic `thread/start` double; it does not prove live unattended
execution. [A1–A4]

## Goals / Non-Goals

Goals: preserve those boundaries; make environment selection independent of
harness selection; identify whether Docker removes more work than it adds; keep
Docker optional; define an evidence-gated adoption decision.

Non-goals: implement an adapter in this change, replace ACS with an agent
framework, rewrite TypeScript/Bun in Go, introduce a distributed scheduler,
change approval ownership, or promise an isolation/performance improvement
without measurements. A worktree separates edits, not process authority.

## Evidence and fit

| Candidate | Observed capability | Fit for ACS |
| --- | --- | --- |
| Direct Codex app-server | Existing reviewed protocol, session operations, delivery and ownership constraints | Baseline: reuses ACS's current adapter investment. Spawning remains unimplemented in production. |
| Docker Agent native runtime | Declarative agents, OCI distribution, model/tool orchestration, native session API, ACP and A2A surfaces | Plausible future harness adapter; not merely an execution environment. |
| Docker Agent with `harness: codex` | Starts and resumes the external Codex CLI; parallel harness dispatch exists | Real spawning support, but not the same protocol or permission profile as ACS's app-server integration. |
| Docker Sandboxes | MicroVM-based environments and a separate `sbx` lifecycle; Codex is a supported agent | More directly relevant to execution isolation, subject to connectivity, permissions and workspace proofs. |

Docker Agent is not synonymous with Docker containers or Docker Sandboxes.
Packaging an agent definition in OCI does not by itself establish filesystem,
network, or process isolation. Docker Agent can be installed as a standalone
binary. Current Sandboxes documentation also describes standalone installation;
do not assume Docker Desktop is mandatory or Linux is unsupported. [D1, S1, S2]

### Codex harness integration is real, but not drop-in

Docker Agent's provider calls `codex.New(cfg.Model)`. Its pinned dependency
constructs `codex exec`, optionally with `resume <sessionID>`, followed by
`--json` and `--dangerously-bypass-approvals-and-sandbox`. The reviewed command
builder has no branch selecting a safer Codex permission profile. [D2–D4]

This is not proof that Docker Agent is unsafe in every deployment: an explicitly
approved external sandbox can supply a different security boundary. It is proof
that this path cannot silently replace ACS's reviewed default. It also does not
connect the child to ACS's shared app-server. A parsed CLI session ID is not, by
itself, authenticated ACS caller identity or proof of runtime delivery reachability.

Harness agents use the external CLI's tools; Docker Agent `toolsets` on those
agents are ignored. Configuring an ACS MCP toolset on the Docker Agent harness
entry therefore does not establish the required connection. The underlying CLI
and its trusted bridge need independent configuration and attestation tests.
Root harness agents are possible, so an additional model-driven coordinator is
not intrinsically required. [D5]

### Native orchestration does not replace ACS semantics

Docker Agent supports nested delegation, background jobs and peer handoffs. A
handoff can switch the active agent in a shared conversation; this is not the
same thing as registering independent ACS agents with separate bindings and
lifetimes. Its internal job identifiers must not become ACS authority. [D6]

The native API exposes session creation, stored history and execution streams.
Its documented follow-up idempotency key does not establish idempotent session
creation, persisted history does not prove that a child process survives a
restart, and preemptive steering is not noninterrupting context delivery. Probe
these independently. Use authenticated, scoped access; a loopback address or
Unix socket name alone does not prove the caller's agent identity. [D7]

A2A support is useful for interoperability, not proof of conformance to ACS's
pinned protocol, task semantics or caller attestation. The Docker A2A docs note
remaining integration limitations. Test the selected surface instead of inferring
compatibility from an A2A dependency or Agent Card. [D8]

### Sandboxes solve a different part of the problem

The preferred optional experiment is a dedicated Codex app-server inside a
managed sandbox, without inserting Docker Agent's coordinator. This is a
candidate architecture, not a documented turnkey ACS integration. [S1, A2]

Prove both directions of connectivity: ACS to the runtime control plane, and
the runtime's ACS tool bridge back to its authorized ACS principal. Host Unix
sockets, loopback addresses and Codex configuration are not assumed to carry
across the VM boundary. Never solve connectivity by exposing the ACS operator
socket or token, sharing the host Docker socket, mounting the whole home
directory, or publishing an unauthenticated control endpoint. The sandbox's
default Codex launch also bypasses Codex's own approval/sandbox layer; selecting
`sbx run codex` is therefore not automatic approval of that policy. [S3]

Workspace mode matters. A host worktree mounted alone cannot resolve its external
`.git` pointer inside the sandbox. It supports file editing, not ordinary Git
operations there. An in-sandbox clone supports Git but retains changes inside
the VM until exported; clone mode alone does not isolate concurrent tasks.
Choose a supported mode deliberately and test it. [S4]

Possible profiles to evaluate are: host worktree with host-owned Git operations;
a dedicated complete clone mounted into the environment; or a VM-local clone
with verified export and retention. Do not broaden mounts to fix worktree Git
access without a separate security review. Named sandbox reuse also means that
creating a logical agent cannot be assumed to create a fresh environment. [S5]

## Decisions

1. Keep direct Codex app-server spawning as the first implementation target.
   Docker is optional and the existing installation still works without it.
2. An operator-owned profile selects a harness adapter, an execution environment
   profile and a workspace provisioner. Validate the supported combination before
   effects. Do not expose arbitrary shell commands, mutable image tags, mounts,
   credentials or network rules to spawning agents.
3. Keep the conceptual environment port small: ensure/inspect an environment and
   explicitly stop/release owned resources. Its reference, ownership evidence,
   reachable transport and workspace mapping are distinct from a runtime session
   reference. Do not freeze a new TypeScript API until the spike resolves transport.
4. Extend intent-first recovery to environment effects. Track workspace,
   environment, runtime session and binding separately. Finding a container/VM
   does not prove a `thread/start` succeeded. Ambiguous creates remain quarantined
   unless an authoritative lookup or idempotency guarantee resolves them.
5. ACS keeps quotas, registration, task semantics, permission boundaries and
   cleanup decisions. A shared environment cannot be stopped for one child without
   checking all ownership references. Coordinator loss does not cascade by default.
6. Run a bounded optional sandbox experiment before a Docker Agent adapter.
   Revisit Docker Agent when its native runtime or multi-harness orchestration is
   itself desired, rather than adding it solely to start Codex processes.

The spec delta records proposed constraints. It does not enable stock bypassing
launchers or change existing OpenSpec approval requirements. Any autonomous
profile needs a separately reviewed policy change and conformance evidence.

## Validation and adoption gates

Use one agent first, then five, on the same repository, task, model and policy
where comparison is valid. Compare direct shared app-server, direct dedicated
app-server and isolated dedicated app-server separately; otherwise process
isolation and sandbox overhead are confounded. A Docker Agent path, if tested,
is a separate arm with its effective policy recorded, not a claimed equivalent.

Required evidence:

- Stable environment/session identity, trusted per-binding MCP attestation,
  bidirectional peer A2A and correct idle/busy delivery provenance.
- Missing approval owner fails closed; no privilege inheritance; an agent cannot
  obtain another binding's or the operator's credentials.
- Lost create replies, disconnects, daemon restarts, partial registration and
  orphaned environments do not produce blind duplicate agents or guessed bindings.
- Stopping an owned worker does not terminate unrelated sessions. Unknown/live
  resources continue consuming reserved quota until resolved.
- Required Git operations work in the chosen workspace mode. Dirty/untracked
  files and commits existing only inside a VM survive failure and cleanup.
  A clean Git status alone is insufficient evidence that all work is exported.
- Measure cold/warm admission-to-ready latency, host and VM aggregate memory,
  CPU, disk use, task completion latency and failure rate. Include sample counts
  and machine/OS/runtime versions. Report model usage where it changes; do not
  fabricate thresholds or wins before establishing a baseline.

Adopt only when the profile passes correctness/security gates and the measured
benefit justifies installation and operational cost. A failed optional Docker
experiment does not block direct Codex spawning. No live spike or benchmark was
run for this research update.

## Migration / Backlog

Account for the separation before freezing #21, #24 and #26. Add environment
ownership/ambiguity cases to #22 and #32, resource accounting to #23, and
workspace export/retention cases to #25. Reflect only implemented capabilities in
#28–#34. These are proposed scope adjustments; this update does not edit issue
bodies or claim ticket completion.

PR #35's earlier document and ADR remain research context. Reconcile the older
branch with main's OpenSpec migration before merging, then validate this change
with the pinned tooling. Do not promote these proposed requirements into main
specs before the corresponding implementation is reviewed and verified.

## Sources

### ACS and Codex

- A1: [ACS README](https://github.com/benediktms/acs/blob/main/README.md).
- A2: [OpenAI app-server documentation](https://developers.openai.com/codex/app-server).
- A3: [Existing spawn research](../../../docs/runtime-spawn.md) and [research PR #35](https://github.com/benediktms/acs/pull/35).
- A4: [Runtime delivery requirements](../../specs/runtime-delivery/spec.md) and [runtime adapter contract](../../../contracts/runtime-adapter.ts).

### Docker Agent

- D1: [Repository overview](https://github.com/docker/docker-agent/blob/5683379ca3518397174acc12a19d32e0ffb1a515/README.md).
- D2: [Harness provider](https://github.com/docker/docker-agent/blob/5683379ca3518397174acc12a19d32e0ffb1a515/pkg/codingharness/provider.go).
- D3: [Pinned dependencies](https://github.com/docker/docker-agent/blob/5683379ca3518397174acc12a19d32e0ffb1a515/go.mod).
- D4: [Pinned Codex command builder](https://github.com/rumpl/harness/blob/9376b9c76461/codex/codex.go).
- D5: [Coding harnesses](https://docker.github.io/docker-agent/features/harnesses/).
- D6: [Multi-agent semantics](https://docker.github.io/docker-agent/concepts/multi-agent/).
- D7: [Native API](https://docs.docker.com/ai/docker-agent/features/api-server/).
- D8: [A2A integration](https://docs.docker.com/ai/docker-agent/features/a2a/).

### Docker Sandboxes

- S1: [Overview](https://docs.docker.com/ai/sandboxes/).
- S2: [Installation and platforms](https://docs.docker.com/ai/sandboxes/install/).
- S3: [Codex configuration and authentication](https://docs.docker.com/ai/sandboxes/agents/codex/).
- S4: [Git workspace modes](https://docs.docker.com/ai/sandboxes/workflows/git/).
- S5: [Lifecycle and workspace usage](https://docs.docker.com/ai/sandboxes/usage/).

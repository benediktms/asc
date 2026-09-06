## Why

The spawning research in #13 / PR #35 separates runtime sessions from ACS
identity and workspace provisioning, but does not distinguish the agent
harness from the environment running it. Docker Agent and Docker Sandboxes
address different parts of that problem. Treating either as a transparent
replacement for the existing Codex app-server boundary would obscure permission,
identity, delivery, and recovery differences.

The source and documentation review dated 2026-09-06 supports keeping direct
Codex app-server spawning as the baseline, while reserving an optional execution
environment boundary. It does not establish production compatibility with either
Docker product. Findings, pinned source revisions, and limitations are in
[design.md](design.md).

## What Changes

- Keep the first production spawning implementation on the reviewed Codex
  app-server lifecycle boundary. Docker is not a prerequisite for ACS or this
  baseline.
- Distinguish harness, execution environment, and workspace provisioning in
  operator-owned profiles, without exposing arbitrary launch commands or adding
  vendor dependencies to the core.
- Retain ACS ownership of admission, identity, bindings, peer A2A delivery,
  lifecycle intent, reconciliation, and cleanup authorization.
- Evaluate Docker Agent as an optional harness/orchestration integration, not as
  an assumed safe Codex launcher. Its reviewed Codex CLI driver uses `exec` and
  unconditionally disables Codex approvals and sandboxing.
- Evaluate Docker Sandboxes separately as an optional execution environment for
  a dedicated Codex app-server. Require evidence for transport, attestation,
  permission ownership, resource cost, and Git/workspace behavior first.
- Define fail-closed requirements and a bounded comparison spike. Do not add a
  Docker dependency, production adapter, new CLI flag, or changed approval policy
  in this planning update.

## Capabilities

### New Capabilities

- `spawn-execution-backends`: optional, profile-controlled execution backends
  which preserve ACS identity, delivery, lifecycle, and retention boundaries.

### Modified Capabilities

None. The existing `runtime-delivery`, `codex-registration`, `local-service`, and
`a2a-messaging` requirements remain in force. Any future integration requiring a
change to those requirements needs its own explicit delta and review.

## Impact

This change adds planning artifacts only. Proposed runtime and workspace
contracts in PR #35 remain research prototypes, not production APIs. Existing
`docs/runtime-spawn.md` and ADR-012 are supporting research, not parallel sources
of normative requirements; current main's OpenSpec specifications take
precedence. This delta covers backend selection and evaluation, not a wholesale
migration or approval of the older spawning draft.

Before freezing #21 / #24 / #26, account for the profile and ownership boundaries
here. Docker experiments are optional follow-up work and do not block the direct
Codex implementation. No claim is made that #21–#34 are implemented or that their
issue bodies have been changed by this update.

PR #35 predates the OpenSpec migration on main and was already reported as
conflicting at the start of this review. Reconcile that branch with main and run
strict OpenSpec validation before merging; adding these artifacts does not
resolve unrelated branch conflicts.

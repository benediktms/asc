# ADR-012: Spawn is a recoverable lifecycle saga

Status: proposed; implementation deferred

## Decision

Dynamic agent creation will be coordinated by ASC as a durable saga across a
runtime-neutral lifecycle adapter and a separate workspace provisioner. A
spawned session becomes an ordinary logical ASC agent after agent, origin,
binding and bound-principal registration commits. Its origin does not restrict
A2A routing and its coordinator does not own its messages or implicitly control
its lifetime.

Lifecycle state, runtime availability and A2A task state remain separate. A
combined spawn-and-delegate UX may link records but does not merge their
semantics. Spawn authority, quota, stop and cleanup use capabilities distinct
from A2A send/read authority.

External effects are intent-first. A runtime operation whose response is lost
after write enters `reconciliation-required` unless the adapter can prove an
idempotency or lookup key. In particular, the reviewed Codex `thread/start`
boundary has no proven spawn-request key, so ASC must not automatically retry an
ambiguous start.

Workspace cleanup is explicit and conservative. Existing paths are never
removed. A managed Git worktree is eligible for removal only after a separate
authorized operation proves it is the recorded worktree and is clean; dirty or
ambiguous paths are retained as `cleanup-required`. Stopping a coordinator does
not cascade by default.

The complete proposed contract, state transitions, Codex mapping, policy and
unknowns are in [the WIP runtime-spawn specification](../runtime-spawn.md).

## Evidence

- The existing app-server client supports `thread/start` and returns the Codex
  thread identity on success.
- The existing SQLite binding transaction creates an active binding and its
  bound-agent principal atomically, but agent creation is currently separate.
- #1 and #4 establish that shared attachment does not grant ASC ownership of
  server-initiated requests. Spawned threads therefore cannot be assumed to run
  unattended.
- #2/#7 establish that Codex behavior is compatibility-profile scoped rather
  than inferred across builds.
- #5 preserves fail-closed wake behavior and exposes effective policy; lifecycle
  creation must not weaken that boundary.
- The spike integration test starts two logical Codex sessions through the
  proposed boundary and proves bidirectional peer A2A acceptance using the real
  application and storage layers.

## Consequences

Production work requires new persistence and application services rather than a
method added to the delivery adapter. Startup can return a durable request
before the runtime is ready. Operators gain explicit states for partial effects,
orphans and retained workspaces. Some ambiguous Codex failures will require
manual resolution until the runtime exposes stronger correlation semantics.

This ADR does not approve production spawning, runtime process supervision,
automatic worktree deletion, recursive spawning, or ASC responses to Codex
approval/input requests.

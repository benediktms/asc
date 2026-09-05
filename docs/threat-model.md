# ACS v1 threat model

Reviewed: 2026-09-05

## Scope

ACS is a same-user, local-machine service. It protects independently launched
agents from identity confusion, stale authority, untrusted peer content, replay,
and accidental network exposure.

A process already running as the same OS user can read ACS files and access its
sockets. Defending against that process, a compromised Codex binary, or remote
multi-user deployment is outside v1.

## Assets and trust boundaries

- Control and bridge credentials authorize local administration and MCP calls.
- Agent bindings associate a logical identity with one current runtime session
  and epoch.
- Task content and results may contain sensitive user or peer data.
- Runtime approvals, filesystem access, and network access remain owned by the
  recipient's local Codex client.
- The loopback A2A endpoint accepts untrusted authenticated protocol input.
- The owner-only Unix control socket accepts authenticated local JSON-RPC.
- MCP metadata and the shared Codex app-server socket cross harness boundaries.
- SQLite is the durable authority for tasks, identities, leases, and audit data.

## Threat review

| Threat                             | Implemented control                                                                                                                                                                                                                                  | Remaining risk or gate                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Model-supplied sender identity     | MCP tools expose no sender parameter. Mutating calls derive the principal from host-owned `_meta.threadId`, the active binding, and its epoch.                                                                                                       | Host metadata stability must still be proven on two supported real Codex builds.                                 |
| Stale or rebound session authority | Active bindings are unique, epochs increase on rebind, delivery attempts are fenced immediately before mutation, and pinned work cannot move after an ambiguous or accepted side effect.                                                             | Real reconnect and authoritative recovery remain integration gates.                                              |
| Cross-agent task mutation          | Executor callbacks require an active bound-agent principal assigned to the target task and, once pinned, the exact binding and epoch.                                                                                                                | None known within the same-user boundary.                                                                        |
| Peer prompt elevation              | Peer content is rendered only as named tool output with `peer-agent` provenance and `trustedForPermissions: false`. It is never rendered as system, developer, user, configuration, or approval input.                                               | The recipient model can still be influenced by task content and must apply its normal policy.                    |
| Permission laundering              | Delivery does not copy sandbox, approval, model, environment, cwd, or network settings. Local input requests update runtime state only and never become A2A answers or approvals.                                                                    | Approval ownership with a TUI and ACS connected simultaneously remains a real-Codex gate.                        |
| Credential disclosure              | Credentials are random, stored as HMAC-SHA-256 verifiers in SQLite, compared in constant time, excluded from envelopes and sanitized logs, and repaired to mode `0600` on startup. The runtime directory is `0700` and the control socket is `0600`. | A compromised same-user process is out of scope.                                                                 |
| Claim replay                       | Claim codes contain 128 random bits encoded in Crockford Base32. Lookup and single-use consumption occur under one immediate SQLite write transaction and claims expire.                                                                             | None known within the same-user boundary.                                                                        |
| Message replay or mutation         | Idempotency is scoped by principal and message ID. Repeating the same canonical request returns the committed result; changing it returns `ACS_IDEMPOTENCY_CONFLICT`.                                                                                | Clients must retain stable message IDs across retries.                                                           |
| Malformed or oversized input       | Loopback configuration is validated, HTTP bodies are bounded before JSON parsing, normalized content and part counts are bounded, schemas validate stored snapshots, and unsupported content fails before runtime mutation.                          | Sustained same-user resource exhaustion is only bounded, not eliminated.                                         |
| Public listener exposure           | v1 configuration rejects non-loopback A2A listeners. The control plane uses an owner-only Unix socket and bearer authentication.                                                                                                                     | Remote deployment is out of scope.                                                                               |
| URI or artifact execution          | URI parts are stored and delivered as information only. ACS does not fetch URLs, open files, resolve symlinks, or invoke handlers.                                                                                                                   | A recipient may choose to access a URI under its own permissions.                                                |
| Crash or ambiguous runtime write   | Durable acceptance commits before success. A disconnect before write is deferred; a disconnect after flush enters `acceptance-unknown`. Exact named wake markers are recovered from Codex history with their turn IDs.                               | Context-only injection is absent from turn history; missing markers remain inconclusive and require an operator. |
| Cancellation of unrelated work     | Only execution IDs created and correlated by ACS can be interrupted. Foreign turn notifications and unowned cancellation requests are ignored or rejected.                                                                                           | Real active-turn behavior remains an integration gate.                                                           |

## Release decision

The implemented controls are covered by storage, control, A2A, adapter,
scheduler, emulator, and compiled-binary tests. v1 release remains fail-closed
until the real-Codex attestation, shared-daemon, safe-delivery, and
approval-ownership gates documented by `acs codex doctor` are completed.

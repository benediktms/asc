# ACS v1 threat model

Reviewed: 2026-09-06

Supporting security analysis; normative requirements are in `openspec/`.

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

| Threat                             | Implemented control                                                                                                                                                                                                                                                                                                                                       | Remaining risk or gate                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Model-supplied sender identity     | MCP tools expose no sender parameter. Mutating calls derive the principal from host-owned `_meta.threadId`, the active binding, and its epoch. Real Codex `0.153.2` and `0.153.4` probes preserve it for normal and resumed threads.                                                                                                                      | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |
| Stale or rebound session authority | Active bindings are unique, epochs increase on rebind, delivery attempts are fenced immediately before mutation, and pinned work cannot move after an ambiguous or accepted side effect. A real Codex `0.153.2` TUI and ACS client concurrently discovered the same thread through one Unix-socket app-server; conformance covers reconnect and recovery. | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |
| Cross-agent task mutation          | Executor callbacks require an active bound-agent principal assigned to the target task and, once pinned, the exact binding and epoch.                                                                                                                                                                                                                     | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |
| Peer prompt elevation              | Peer content is rendered only as named tool output with `peer-agent` provenance and `trustedForPermissions: false`. It is never rendered as system, developer, user, configuration, or approval input.                                                                                                                                                    | The recipient model can still be influenced by task content and must apply its normal policy.                             |
| Permission laundering              | Delivery does not copy sandbox, approval, model, environment, cwd, or network settings. User-routed command approvals remain exclusive to the TUI. ACS records fanned-out local-input requests but never answers them, so a missing local owner fails closed.                                                                                             | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |
| Credential disclosure              | Credentials are random, stored as HMAC-SHA-256 verifiers in SQLite, compared in constant time, excluded from envelopes and sanitized logs, and repaired to mode `0600` on startup. The runtime directory is `0700` and the control socket is `0600`.                                                                                                      | A compromised same-user process is out of scope.                                                                          |
| Claim replay                       | Claim codes contain 128 random bits encoded in Crockford Base32. Lookup and single-use consumption occur under one immediate SQLite write transaction and claims expire. A retry succeeds only for the still-active session that consumed the claim; every other replay fails.                                                                            | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |
| Message replay or mutation         | Idempotency is scoped by principal and message ID. Repeating the same canonical request returns the committed result; changing it returns `ACS_IDEMPOTENCY_CONFLICT`.                                                                                                                                                                                     | Clients must retain stable message IDs across retries.                                                                    |
| Malformed or oversized input       | Loopback configuration is validated, HTTP bodies are bounded before JSON parsing, normalized content and part counts are bounded, schemas validate stored snapshots, and unsupported content fails before runtime mutation.                                                                                                                               | Sustained same-user resource exhaustion is only bounded, not eliminated.                                                  |
| Public listener exposure           | v1 configuration rejects non-loopback A2A listeners. The control plane uses an owner-only Unix socket and bearer authentication.                                                                                                                                                                                                                          | Remote deployment is out of scope.                                                                                        |
| URI or artifact execution          | URI parts are stored and delivered as information only. ACS does not fetch URLs, open files, resolve symlinks, or invoke handlers.                                                                                                                                                                                                                        | A recipient may choose to access a URI under its own permissions.                                                         |
| Crash or ambiguous runtime write   | Durable acceptance commits before success. A disconnect before write is deferred; a disconnect after flush enters `acceptance-unknown`. Exact named direct-delivery markers and payload hashes are recovered from Codex history with their turn IDs.                                                                                                      | Missing or conflicting markers remain inconclusive; no history append or blind resubmission is permitted.                 |
| Cancellation of unrelated work     | Canceling a task is separate from interrupting a runtime. Mere creation/correlation cannot prove isolation; the shared-endpoint Codex adapter rejects interruption. Foreign thread/turn events are ignored.                                                                                                                                               | Existing evidence is scoped to the tested topology; rerun the interactive ownership matrix for changed delivery behavior. |

## Verification boundary

Storage, A2A, control, scheduler, mock-adapter, compiled-binary, and isolated
real-Codex/local-mock-model checks cover the direct-delivery path. Interruption
is disabled for the shared Codex adapter, regardless of whether an execution
contains one or several known peer messages. Normal delivery never changes the
recipient's permissions or answers local input requests.

The isolated native test verifies what the real harness sends to the model HTTP
endpoint, not that a live model understands the message. It also does not
re-establish desktop/TUI approval routing. Previous interactive probe observations
remain historical evidence for those exact versions/topologies, not proof of
this changed path. See `direct-delivery-verification.md` before widening claims.

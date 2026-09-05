# Agent Communications Service

Local-first A2A messaging for independently launched Codex threads.

```sh
bun install
bun run check
bun run format
bun run build
./dist/acs init
./dist/acs daemon start
```

The daemon listens on `127.0.0.1:7432`. Run `acs --help` for administration,
binding, diagnostics, and MCP bridge commands.

Create and securely claim the current Codex session without copying a thread
ID:

```sh
acs agents create backend --claim
# In the intended Codex session, call acs_claim with the returned claimCode.
```

For operator-driven binding, `acs codex bind backend` opens a discovered-session
picker; automation can use `acs codex bind backend --session <opaque-thread-id>`.
See [the registration contract](docs/registration.md) for retry and rebind
semantics.

`bun run check` runs TypeScript, oxlint (including `no-explicit-any` and bans on
handwritten type assertions and non-null assertions), oxfmt, package
import-boundary checks, and the test suite. Persistence uses Bun's native SQLite
driver directly; there is no ORM.

The pinned official A2A JSON-RPC profile can be run with:

```sh
A2A_TCK_DIR=/path/to/a2a-tck bun run test:a2a-tck
```

The runner verifies the exact revision in
`conformance/a2a-profile-v1.json` and rejects both new failures and stale
exceptions. See the normative [ASC A2A v1 profile](docs/a2a-profile.md) for the
supported protocol surface, extension boundary, and exception-review policy.

## Current conformance boundary

Implemented: standalone Bun binary, SQLite migration and restart, authenticated
versioned Unix-socket control plane, agent/claim/binding administration, runtime
diagnostics, A2A v1 Agent Cards and JSON-RPC send/get/list/cancel, durable
idempotent acceptance, retries and recovery controls, context delivery, result
capture, task notifications, and the Codex MCP stdio tool surface with
host-metadata attestation.

Context-only delivery is enabled. Wake delivery is fail-closed by default because
current Codex queue input cannot preserve named tool-output provenance; it needs
an explicit per-binding `--allow-non-atomic-wake` policy. Generic
acceptance-unknown reconciliation is automatic, with operator resolution when
the Codex adapter cannot prove authoritative history. Wake acceptance can be
recovered from its durable named function-output marker; context-only ambiguity
remains operator-owned because injected items are absent from turn history.
The phase-zero gates are complete. Codex `0.153.2` and `0.153.4` share the pinned
client protocol, pass delivery probes, and preserve host-owned MCP thread
metadata for normal and resumed threads. A real Codex `0.153.2` TUI and ACS
client concurrently discovered the same thread and delivered lifecycle
notifications through one Unix-socket app-server; reconnect behavior is covered
by the adapter conformance suite. User-routed command approvals remain exclusive
to the TUI. `requestUserInput` fans out to every subscribed client, but ACS never
answers it, so a missing local owner fails closed.

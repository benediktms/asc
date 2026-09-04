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

`bun run check` runs TypeScript, oxlint (including `no-explicit-any` and a ban
on handwritten type assertions), oxfmt, package import-boundary checks, and the
test suite. Persistence uses Bun's native SQLite driver directly; there is no
ORM.

The pinned official A2A JSON-RPC profile can be run with:

```sh
A2A_TCK_DIR=/path/to/a2a-tck bun run test:a2a-tck
```

The runner verifies the exact revision in
`conformance/a2a-tck-revision.txt` and rejects any failure outside the reviewed
requirement-level allowlist.

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
the Codex adapter cannot prove authoritative history. Two-build MCP metadata,
approval ownership, and real-Codex reconciliation remain release gates and are
reported honestly rather than inferred from emulator tests.

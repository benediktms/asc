# Agent Communications Service

Local-first A2A messaging for independently launched Codex threads.

```sh
bun install
bun run check
bun run format
bun run build
./dist/acs init
./dist/acs daemon run
```

The daemon listens on `127.0.0.1:7432`. Run `acs --help` for administration,
binding, diagnostics, and MCP bridge commands.

`bun run check` runs TypeScript, oxlint (including `no-explicit-any`), oxfmt,
package import-boundary checks, and the test suite.

## Current conformance boundary

Implemented: standalone Bun binary, SQLite migration and restart, authenticated
versioned Unix-socket control plane, agent/claim/binding administration, runtime
diagnostics, A2A v1 Agent Cards and JSON-RPC send/get/list/cancel, durable
idempotent acceptance, retries and recovery controls, context delivery, result
capture, task notifications, and the Codex MCP stdio tool surface with
host-metadata attestation.

Context-only delivery is enabled. Wake delivery is fail-closed by default because
current Codex queue input cannot preserve named tool-output provenance; it needs
an explicit per-binding `--allow-non-atomic-wake` policy. Two-build MCP metadata,
approval ownership, A2A TCK, and acceptance-unknown reconciliation remain release
gates and are reported honestly rather than inferred from unit tests.

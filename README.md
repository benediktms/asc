# Agent Communications Service

Local-first A2A messaging for independently launched Codex threads.

```sh
bun install
bun run check
bun run build
./dist/acs init
./dist/acs daemon run
```

The daemon listens on `127.0.0.1:7432`. Run `acs --help` for administration,
binding, diagnostics, and MCP bridge commands.

Codex delivery stays fail-closed until `acs codex doctor` reports the required
runtime capabilities as proven.

## Current conformance boundary

Implemented: standalone Bun binary, SQLite migration and restart, authenticated
Unix-socket control plane, agent catalogue/manual binding, A2A v1 Agent Cards and
JSON-RPC send/get/list/cancel, durable idempotent acceptance, deferred delivery
visibility, and the Codex MCP stdio tool surface with host-metadata attestation.

Deliberately disabled pending the specification's mandatory phase-zero evidence:
shared Codex app-server attachment, context injection, wake delivery, automatic
turn result capture, runtime cancellation/reconciliation, and approval routing.
`acs codex doctor` reports these gates and the daemon never substitutes an unsafe
delivery mechanism.

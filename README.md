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

## Install and daemon lifecycle

Release artifacts are standalone executables; Bun and `node_modules` are not
required on the target machine. Install a downloaded release into a private
per-user prefix, initialize ASC, and start it in the background:

```sh
chmod +x ./acs
./acs install --prefix "$HOME/.local" --non-interactive
acs init
acs daemon start
acs daemon status
acs codex install-mcp
```

`install` copies the executable to a platform- and version-specific directory
under the prefix, then atomically changes `bin/acs`. An already-running daemon
continues using its original executable until `acs daemon restart` is requested.
The Codex MCP registration uses the stable `bin/acs` path recorded during
installation.

`acs daemon run` remains the foreground/debugging command. `start`, `status`,
`restart`, and `stop` manage a detached per-user process without systemd or
launchd. Lifecycle operations are serialized; status and stop validate the PID,
OS process-start marker, executable, and command before treating a record as
live or sending a signal. The daemon first receives a control-plane shutdown,
then bounded TERM/KILL fallbacks if necessary.

Logs are written to the platform data directory under `logs/daemon.log`. At
startup, files at least 5 MiB are rotated, retaining three older files. See
[the deployment specification](docs/deployment.md) for paths and safety rules.

```sh
acs daemon stop
acs uninstall
```

Uninstall removes only the recorded ASC symlink and owned version directory.
Configuration, databases, logs, and secrets are preserved.

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

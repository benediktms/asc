# Agent Communications Service

Local-first A2A messaging for independently launched Codex threads.

```sh
mise install
mise exec -- bun install --frozen-lockfile
bun run check
bun run format
bun run build
./dist/acs init
```

On macOS, `init` installs and starts a `launchd` user service and registers the
global Codex MCP bridge with the same socket path. The service starts at login
and restarts if it exits; logs are in `~/Library/Logs/acs.log`. Re-running `init`
updates the registration and retires the legacy `local.asc.daemon` service. Restart existing Codex sessions to load the MCP tools.
Use `acs init --no-service` for file initialization only (for example in tests).
On other platforms, start `acs daemon start` under your service manager.

`init` migrates a running foreground daemon to the login service and restarts
an existing service so rebuilt binaries take effect. `acs daemon start` refuses
to replace a live control socket.

### Receiving messages in independently launched sessions

MCP registration and runtime delivery are separate connections. A successful
`acs_identity` proves the session's identity, not that ACS's shared app-server
hosts it. For automatic context delivery, launch/resume the recipient through
the shared endpoint (`codex --remote unix:// resume <session-id>`).

If the recipient runs elsewhere, use `acs_inbox_list`, then `acs_task_get` to
read a message and its delivery ID. Pass both task and delivery IDs to
`acs_task_acknowledge`; this accepts everything observed by that read without
swallowing a concurrent follow-up. Context delivery stays deferred while that
thread is not loaded on the connected app-server; ACS does not resume a second
copy of an active session. Complete accepted tasks with `acs_task_complete`.

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
`conformance/a2a-tck-revision.txt` and rejects any failure outside the reviewed
requirement-level allowlist.

## Development workflow

Activate mise in your shell, or prefix commands with `mise exec --`.
`mise.toml` pins Bun, Node (for OpenSpec), OpenSpec, Python, and uv (for the A2A
TCK). JavaScript dependencies, including Codex `0.153.2`, are already pinned
in `package.json` and `bun.lock`.

Behavioral requirements now live in [OpenSpec specs](openspec/specs).
Use the generated Codex skills: `$openspec-propose` to propose a change,
`$openspec-apply-change` to implement it, and `$openspec-archive-change` to
archive it after verification. Validate artifacts with `mise run specs:check`.
The [OpenSpec workflow documentation](https://github.com/Fission-AI/OpenSpec)
describes the workflow. Existing `docs/adr`, security documentation, and typed
`contracts/` remain supporting references; keep them consistent with the specs.
OpenSpec is the planning workflow for new changes; existing local Threadmark
history is retained as historical context.

For the external TCK checkout, use `uv sync --frozen --python "$(command -v python)" --directory "$A2A_TCK_DIR"`
before running the conformance command above.

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

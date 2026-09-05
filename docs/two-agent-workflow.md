# Canonical two-agent workflow

The release-level workflow is one `architect` Codex thread assigning work to a
distinct `backend` Codex thread through ASC:

1. Both threads claim their logical agents through `acs_claim`.
2. `architect` calls `acs_send`. The returned `submitted` task and delivery ID
   prove durable A2A acceptance; they do not claim runtime acceptance.
3. The scheduler fences the binding ID and epoch selected at acceptance, then
   the Codex adapter delivers a canonical peer-agent envelope. Only a correlated
   Codex execution moves the task to `working`.
4. `backend` calls `acs_task_request_input`. Ending that Codex turn preserves
   `input-required`; it is not treated as implicit task completion.
5. `architect` calls `acs_task_reply`, and `backend` calls
   `acs_task_complete` with its summary and artifacts.
6. The completed task remains queryable after an ASC restart.

## Deterministic CI proof

`tests/two-agent-e2e.test.ts` crosses the real MCP stdio bridge, authenticated
Unix-socket control protocol, loopback A2A server, scheduler, SQLite store, and
Codex adapter. Only the Codex app-server peer is emulated; there are no model
calls and no assertions on prose. It also covers duplicate and conflicting
message IDs, busy and offline recovery, strict binding fencing, ambiguous-write
reconciliation, cancellation before queued work can run and during an
ASC-owned execution, and approval non-ownership.

Every scenario failure includes the last MCP correlation ID and a sanitized
protocol timeline. The timeline contains only event names and opaque task,
delivery, thread, and turn IDs.

## Opt-in real Codex proof

Start ASC against the supported shared Codex app-server topology, open two Codex
threads, and run:

```sh
bun run test:codex-e2e
```

The guided verifier creates one-time claims and waits while the two real threads
perform the same task/input/reply/completion cycle. It deliberately does not
inject `_meta` or imitate a model call: the MCP metadata must come from Codex.
On success it writes a sanitized JSON timeline beneath `artifacts/`. Claim codes,
message text, filesystem paths, and model output are not included.

The existing `bun run test:codex-model` probe remains the lower-level check for
model visibility, resumed-thread MCP attribution, busy delivery, and owned-turn
cancellation.

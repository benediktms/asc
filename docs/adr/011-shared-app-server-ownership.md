# ADR-011: Shared app-server ownership is evidence-scoped

Status: proposed; matrix incomplete

## Decision

ASC may attach to the same Codex app-server as an interactive client, but it
must remain a non-answering observer for every server-initiated request. A
successful shared idle-thread probe does not establish ownership of approvals,
user input, settings, MCP configuration, or an active turn. Features that need
one of those ownership guarantees remain unavailable until the corresponding
matrix cell has real-Codex evidence.

The existing adapter complies with that boundary: it records runtime input
requests as state and sends no JSON-RPC response. Request classification and
diagnostics are specified separately by ADR-010; this ADR governs only topology
and routing conclusions.

## Current evidence

`verified` means a real Codex observation exists in the repository history or
current opt-in suite. `emulated` means deterministic adapter conformance only.
An empty matrix cell is not inferred from adjacent cells.

| Case                                                        | 0.153.2              | 0.153.4              | Consequence                                               |
| ----------------------------------------------------------- | -------------------- | -------------------- | --------------------------------------------------------- |
| TUI and ASC discover the same idle thread                   | verified             | unknown              | shared attachment is permitted                            |
| lifecycle notifications reach TUI and ASC                   | verified             | unknown              | ASC may observe shared idle state                         |
| `requestUserInput` routing                                  | verified fan-out     | unknown              | ASC observes and never answers                            |
| command-approval routing                                    | verified TUI-owned   | unknown              | ASC never approves                                        |
| normal/model turn routing on a shared TUI thread            | unknown              | unknown              | no ownership claim                                        |
| tool-execution routing on a shared TUI thread               | unknown              | unknown              | no ownership claim                                        |
| cancellation routing on a shared TUI thread                 | unknown              | unknown              | cancellation remains limited to ACS-created execution IDs |
| ASC disconnect/reconnect while TUI remains attached         | emulated             | emulated             | production behavior still needs a real probe              |
| TUI disconnect/reconnect while ASC remains attached         | unknown              | unknown              | no continuity claim                                       |
| dormant thread resume and subscription                      | isolated resume only | isolated resume only | shared routing remains unknown                            |
| attachment changes settings, MCPs, approvals, or turn owner | unknown              | unknown              | attachment must not be treated as configuration           |

The generated protocol and isolated delivery/attestation probes match across
the two supported versions, but that is not shared-topology evidence.

## Reproducible probe

The recorder in `scripts/probe-codex-ownership.ts` connects two deliberately
non-answering app-server clients. It creates a mode-`0600` evidence file and
refuses to overwrite an existing path. It stores the runtime version, method
names, identifiers, payload shape, and a shape fingerprint as NDJSON; it does
not store prompts, tool arguments, answers, command text, or model output.

When `--thread` is supplied, snapshots also fingerprint the non-content
configuration fields returned by `thread/read`. Comparing the `before` and
`after` fingerprints detects visible attachment changes without retaining the
thread preview, paths, history, or output. Approval policy is not exposed in the
current thread response, so unchanged fingerprints cannot prove that hidden
server state is unchanged.

Start the target Codex build with a Unix-socket app-server and attach its TUI to
that socket. In a second terminal, run one recorder scenario:

```sh
bun run probe:codex-ownership -- \
  --socket /absolute/path/to/app-server.sock \
  --output /tmp/asc-ownership-observe.ndjson \
  --scenario observe \
  --duration-ms 120000

bun run probe:codex-ownership -- \
  --socket /absolute/path/to/app-server.sock \
  --output /tmp/asc-ownership-reconnect.ndjson \
  --scenario reconnect \
  --phase-ms 3000 \
  --duration-ms 120000

bun run probe:codex-ownership -- \
  --socket /absolute/path/to/app-server.sock \
  --output /tmp/asc-ownership-resume.ndjson \
  --scenario resume \
  --thread THREAD_ID \
  --duration-ms 30000
```

During `observe`, exercise these actions one at a time and retain the timestamps:

1. Start and complete a normal turn.
2. Run a tool that needs no approval.
3. Trigger `requestUserInput` and answer it only in the TUI.
4. Trigger a command approval and answer it only in the TUI.
5. Start a long turn and cancel it from the TUI.
6. Exit and reconnect the TUI while the recorder stays connected.
7. Exit the TUI, allow the thread to become dormant, then reconnect it.

Repeat the sequence for each supported Codex build. Compare routing by the same
`threadId`, `turnId`, or `itemId`; do not infer broadcast from similarly timed
events. Record the exact Codex version, platform, launch commands, action
timestamps, and recorder commit with the result. The NDJSON is local evidence
and may contain thread identifiers, so it must not be committed unchanged.

The `resume` scenario is intentionally explicit because it mutates attachment
state. The other scenarios issue no thread mutation after initialization.

## Dedicated app-server boundary

A dedicated app-server is required whenever an integration needs to own or
answer server requests, establish unattended approval behavior, or isolate
settings/MCP configuration. ASC currently does none of those things. Sharing is
allowed only for observation and the existing fail-closed delivery policy; it
does not transfer local-client ownership to ASC.

## Exit criteria

This ADR can become accepted when every unknown cell above has either:

- reproducible evidence on both supported versions, or
- an explicit fail-closed product decision that makes the behavior irrelevant.

Any version change invalidates only that version's cells, not the evidence for
other builds.

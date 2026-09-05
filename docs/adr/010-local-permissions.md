# ADR-010: Permission prompts remain local

Status: accepted

ACS does not approve recipient actions or treat peer content as permission.

The Codex adapter uses the versioned
`codex-server-request-ownership-v1` table. It is checked exhaustively against the
server-request method manifest generated from the pinned Codex schema. The
supported `0.153.2` and `0.153.4` builds have the same schema. Each method is
assigned one of four policies:

| Policy                    | Meaning in v1                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `observe-only`            | Project non-sensitive wait state when it belongs to an ASC-owned execution; never respond.                  |
| `owned-by-local-client`   | Leave the request entirely to the TUI or other local owner; never respond.                                  |
| `safe-to-answer`          | Reserved for a future explicit ownership contract; no current method uses it.                               |
| `unsupported-fail-closed` | Do not respond, record a redacted diagnostic, and block wake when the request identifies the target thread. |

Command, file-change, permission, and legacy approvals are local-client-owned.
MCP elicitations and ChatGPT token refresh are local-client-owned.
`requestUserInput` is observe-only. Dynamic tool calls, attestation generation,
and external-clock reads are unsupported. Any method absent from the generated
manifest defaults to unsupported/fail-closed and is surfaced by method name
only; request parameters and prompt text are never logged.

A real Codex `0.153.2` probe with a TUI and ACS subscribed to the same thread
showed that `item/tool/requestUserInput` is delivered to both clients. The TUI
remains the only client that answers; ACS records the wait and does not send a
response. A second probe with `approvalsReviewer=user` showed that a command
approval is routed only to the TUI; ACS receives no server request and the
command remains blocked. Without a local owner, ACS's non-response fails closed.

An observed blocking server request is tracked until `serverRequest/resolved` or
turn completion. Wake delivery to that thread remains deferred even if a stale
thread snapshot says `idle`. This avoids turning a peer message into an implicit
resolution, ownership transfer, or replacement turn.

`acs_task_request_input` belongs to the A2A task protocol. It lets the assigned
executor request more peer task input; it cannot resolve a Codex-local question,
approval, authentication request, or MCP elicitation.

The phase-zero real probes establish the two observed routing cases above. The
emulator covers every schema method, unknown-method diagnostics, response
absence, redaction, and wake blocking. Additional real probes must be recorded
as evidence when Codex routing or supported permission profiles change; this ADR
does not claim unperformed probes.

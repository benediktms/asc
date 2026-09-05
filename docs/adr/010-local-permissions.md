# ADR-010: Permission prompts remain local

Status: accepted

ACS does not approve recipient actions or treat peer content as permission.

A real Codex `0.153.2` probe with a TUI and ACS subscribed to the same thread
showed that `item/tool/requestUserInput` is delivered to both clients. The TUI
remains the only client that answers; ACS records the wait and does not send a
response. A second probe with `approvalsReviewer=user` showed that a command
approval is routed only to the TUI; ACS receives no server request and the
command remains blocked. Without a local owner, ACS's non-response fails closed.

# ADR-010: Permission prompts remain local

Status: accepted

ACS does not approve recipient actions or treat peer content as permission. Wake that could transfer approval ownership remains disabled until the ownership gate is proven.

A real Codex `0.153.2` probe with a TUI and ACS subscribed to the same thread
showed that `item/tool/requestUserInput` is delivered to both clients. The TUI
remains the only client that answers; ACS records the wait and does not send a
response. This fan-out means the ownership gate is unsafe, not merely untested.

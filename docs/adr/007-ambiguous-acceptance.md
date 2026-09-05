# ADR-007: Ambiguous execution starts are not blindly retried

Status: accepted

After a flushed request loses its response, delivery enters `acceptance-unknown`. The adapter reconciles a wake when Codex history contains its exact named `receive_agent_message` delivery marker and recovers the owning turn ID. A missing marker is inconclusive because context-only injection is not represented in turn history; it requires audited operator resolution and is never blindly retried.

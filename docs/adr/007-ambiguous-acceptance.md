# ADR-007: Ambiguous execution starts are not blindly retried

Status: accepted

After a flushed request loses its response, delivery enters `acceptance-unknown`. The adapter reconciles when authoritative history exists; otherwise an audited operator resolution is required.

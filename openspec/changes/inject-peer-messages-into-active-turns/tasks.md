## 1. Direct Delivery Contract

- [ ] 1.1 Replace `wake_when_idle`, `append_context`, and `join_active` with `direct` across the runtime, A2A, MCP, control, and JSON Schema contracts; verify typecheck and schema validation reject removed modes.
- [ ] 1.2 Add a SQLite migration that rewrites non-terminal legacy delivery intents to `direct` while preserving IDs, epochs, attempts, and idempotency records; verify the targeted storage migration tests pass.
- [ ] 1.3 Remove per-binding wake strategy and active-steering flags from configuration and diagnostics; verify the targeted config and control tests pass.

## 2. Codex Direct Injection

- [ ] 2.1 Extend the Codex protocol codec and app-server client with typed `turn/steer` support using `expectedTurnId`, empty input, and untrusted additional context keyed by delivery ID; verify the generated-protocol check and targeted client tests pass.
- [ ] 2.2 Expose the active turn ID during session inspection and implement direct delivery so busy steerable sessions use `turn/steer` while idle sessions use named-tool-output `turn/start`; verify the targeted runtime adapter conformance tests pass.
- [ ] 2.3 Map changed-turn, non-steerable-turn, dormant, unloaded, and offline outcomes to deferred delivery without `thread/inject_items`; verify mutation assertions in the targeted adapter tests observe no history append.
- [ ] 2.4 Add exact delivery-marker reconciliation for steer requests and retain `acceptance-unknown` when history is inconclusive; verify the targeted ambiguous-write adapter tests pass.

## 3. Shared Turn Correlation

- [ ] 3.1 Change runtime execution persistence and in-memory correlation so several delivery IDs can reference one active turn; verify the targeted storage and scheduler tests cover two deliveries sharing a turn.
- [ ] 3.2 Require explicit task completion, failure, or input request for tasks injected into an already-running turn while retaining automatic result capture for ACS-started turns; verify the targeted scheduler tests distinguish both cases.

## 4. External Behavior and Evidence

- [ ] 4.1 Remove caller-selected delivery policy from A2A and MCP send surfaces, default accepted messages to direct delivery, and return invalid parameters for removed modes; verify the targeted A2A and MCP tests pass.
- [ ] 4.2 Update runtime capability evidence for the pinned Codex profile only after a real-Codex test proves active `turn/steer`, untrusted provenance, expected-turn fencing, and marker visibility; verify the targeted real-Codex test file passes or leave the capability disabled.
- [ ] 4.3 Update ADRs, threat model, README, conformance report, and two-agent workflow to describe direct delivery and its route requirement; verify stale history-append and polling-as-delivery claims are absent with a targeted text search.
- [ ] 4.4 Reconcile the implementation with https://github.com/benediktms/acs/pull/14, https://github.com/benediktms/acs/pull/15, https://github.com/benediktms/acs/pull/16, https://github.com/benediktms/acs/pull/19, and https://github.com/benediktms/acs/pull/35; verify each remaining PR either targets the direct-delivery contract or is explicitly superseded.
- [ ] 4.5 Run strict OpenSpec validation plus only the affected test files, typecheck, lint, formatting, import-boundary, enum, and generated-protocol checks; leave the full test suite to CI.

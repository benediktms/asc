## 1. Direct Delivery Contract

- [ ] 1.1 Replace `wake_when_idle`, `append_context`, and `join_active` with `direct` across the runtime, A2A, MCP, control, and JSON Schema contracts; verify typecheck and schema validation reject removed modes.
- [ ] 1.2 Remove per-binding wake strategy and active-steering flags from configuration and diagnostics; verify the targeted config and control tests pass.
- [ ] 1.3 Update the initial storage/schema representation directly to the direct-delivery model; do not add unused legacy-row migration or rollback compatibility machinery.

## 2. Codex Native Direct Injection

- [ ] 2.1 Extend the Codex protocol codec and app-server client with typed named-tool-output `turn/start` submission using empty `input`, `namespace: "acs"`, `name: "receive_agent_message"`, and the canonical delivery envelope; verify generated-protocol checks and targeted client tests pass.
- [ ] 2.2 Implement direct delivery so a reachable recipient session receives the named tool output whether Codex starts a new turn or accepts the input into a supported existing turn; record the accepting turn ID and do not infer ownership from the method name.
- [ ] 2.3 Add runtime evidence for `started | joined | unknown` execution relationship when Codex can establish it; verify the adapter never reports `started` merely because `turn/start` was called.
- [ ] 2.4 Map dormant, unloaded, offline, locally-blocked, stale-binding, unsupported-active-state, and route-unavailable outcomes to deferred delivery without `thread/inject_items`; verify targeted adapter mutation assertions observe no history append.
- [ ] 2.5 Add exact delivery-marker reconciliation for direct requests and retain `acceptance-unknown` when runtime evidence is inconclusive; verify ambiguous-write adapter tests do not blindly resend.
- [ ] 2.6 Add an upstream-evidence regression test/documentation note that empty-input `turn/steer` with only `additionalContext` is rejected by the pinned Codex profile; do not fabricate user input as a workaround.

## 3. Shared Turn Correlation and Task Semantics

- [ ] 3.1 Change runtime execution persistence and in-memory correlation so several delivery IDs can reference one runtime turn; verify storage and scheduler tests cover multiple deliveries sharing a turn.
- [ ] 3.2 Require explicit task completion, failure, or input request for **all** delegated tasks, including tasks whose first delivery started a new Codex turn; verify `turn/completed` records runtime execution state but does not terminally transition the A2A task.
- [ ] 3.3 Keep message/task reply correlation explicit and task-specific; verify a shared final assistant response is not automatically attributed to every delivery in the turn.
- [ ] 3.4 Harden cancellation so canceling one peer task does not interrupt a shared or user-owned turn unless ACS can prove isolated execution ownership and policy permits interruption; verify targeted scheduler/runtime tests.

## 4. External Behavior and Evidence

- [ ] 4.1 Remove caller-selected delivery policy from A2A and MCP send surfaces, default accepted messages to direct delivery, and return invalid parameters for removed modes; verify targeted A2A and MCP tests pass.
- [ ] 4.2 Update runtime capability evidence for the pinned Codex profile only after a real-Codex test proves: idle direct delivery, active-session direct delivery, peer/tool provenance, returned/observed turn correlation, local-input/approval safety, and no history-append fallback. Leave the capability disabled if any required behavior cannot be proven.
- [ ] 4.3 Add a real-Codex test for several peer messages delivered to one active turn and verify their task/reply correlations remain independent.
- [ ] 4.4 Add a real-Codex ambiguous-write test where feasible; verify a lost response after write leads to authoritative reconciliation or `acceptance-unknown`, never blind retry.
- [ ] 4.5 Update ADRs, threat model, README, conformance report, and two-agent workflow to describe direct session delivery, explicit task completion, and route requirements; verify stale history-append/polling-as-delivery claims are absent with a targeted text search.
- [ ] 4.6 Reconcile the implementation with https://github.com/benediktms/acs/pull/14, https://github.com/benediktms/acs/pull/15, https://github.com/benediktms/acs/pull/16, https://github.com/benediktms/acs/pull/19, and https://github.com/benediktms/acs/pull/35; verify each remaining PR either targets the direct-delivery contract or is explicitly superseded.
- [ ] 4.7 Run strict OpenSpec validation plus affected test files, typecheck, lint, formatting, import-boundary, enum, and generated-protocol checks; leave the full suite to CI.

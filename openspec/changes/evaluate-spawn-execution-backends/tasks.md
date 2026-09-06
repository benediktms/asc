## 1. Reconcile and validate the planning baseline

- [ ] 1.1 Reconcile PR #35 with current main's OpenSpec migration without restoring ADRs as normative requirements; migrate any remaining foundational spawning requirements before implementing them.
- [ ] 1.2 Validate this change with the pinned OpenSpec CLI and run `mise run specs:check` after reconciliation. Review all relative links and requirement scenarios.
- [ ] 1.3 Before freezing #21, #24 and #26, reflect the harness/environment/workspace distinction in their proposed contracts and issue scope. Do not implement a Docker backend as a prerequisite for direct Codex spawning.

## 2. Baseline and feasibility gates

- [ ] 2.1 Record exact ACS, Codex, Docker Agent, harness dependency and Sandboxes versions, OS, architecture, machine resources and effective permission profiles. Recheck source findings against the selected released binaries.
- [ ] 2.2 Establish one-agent direct shared-app-server and dedicated-app-server baselines using the existing targeted spawn test and a live, explicitly authorized harness probe.
- [ ] 2.3 Prove a dedicated Codex app-server can run in the chosen sandbox while preserving the approved permission policy. Keep the stock bypassing launcher disabled for incompatible profiles; a policy exception requires a separate proposal.
- [ ] 2.4 Prove the two transport directions, scoped secrets, trusted per-binding MCP attestation and no operator authority exposure. Stop the experiment if these gates cannot be met.
- [ ] 2.5 Test required Git operations for the selected workspace mode. Cover host-worktree pointer failure and preservation/export of VM-local commits, tracked edits and untracked files.

## 3. Bounded lifecycle and delivery experiment

- [ ] 3.1 Implement a research-only environment adapter behind opaque references and operator profiles; do not wire it into production by default.
- [ ] 3.2 Add targeted tests for lost environment-create and thread-start replies, restart, partial binding, quota retention, version/profile rejection and owned-resource cleanup. Keep environment proof separate from session proof.
- [ ] 3.3 Prove bidirectional A2A between independently registered workers, idle/busy delivery provenance, fail-closed input ownership and safe stopping without affecting unrelated sessions.
- [ ] 3.4 Repeat the successful baseline and sandbox probes with five workers. Measure cold/warm readiness, aggregate host/VM memory, CPU, disk, task latency and failure rate with sample counts and reproducible inputs.

## 4. Conditional Docker Agent evaluation and decision

- [ ] 4.1 Only if native Docker Agent or its harness orchestration adds a desired capability beyond launching Codex, select one programmatic surface for an adapter spike. Verify underlying-CLI MCP configuration; do not rely on ignored harness toolsets.
- [ ] 4.2 Test session-creation ambiguity, stream recovery, task mapping, caller attestation and permission ownership independently. Do not infer spawn idempotency from follow-up deduplication or peer compatibility from A2A advertisement.
- [ ] 4.3 Publish a go/no-go comparison with measured operational benefit and unresolved gaps. Preserve direct Codex spawning regardless of the optional Docker result.
- [ ] 4.4 Create implementation-sized follow-ups only for the accepted profile, update affected #21–#34 scope explicitly, and add targeted conformance tests plus operator documentation. Run only affected test files locally; leave the full suite to CI.

No live Docker/Codex integration or benchmark was executed in the research update
that introduced these artifacts. The unchecked tasks are future work, not claims
of completion. Strict OpenSpec validation also remains pending.

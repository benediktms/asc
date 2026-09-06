## 1. Urgency contract

- [ ] 1.1 Add `normal`, `high`, and `preempt` urgency to the A2A/MCP/runtime-neutral delivery contracts; default to `normal`; verify removed/unknown values fail validation.
- [ ] 1.2 Add scheduler priority for `high` with anti-starvation coverage; verify `high` never causes runtime interruption.
- [ ] 1.3 Add explicit preemption authorization/policy checks separate from ordinary send/cancel scopes.

## 2. Runtime interruption

- [ ] 2.1 Add a harness-neutral interruption capability and opaque execution-target contract; keep harness-specific turn/process identifiers inside adapters.
- [ ] 2.2 Map authorized Codex preemption to exact `turn/interrupt`, then wait for safe runtime state before submitting the peer message through the existing named-tool-output direct-delivery path.
- [ ] 2.3 Handle accepted, not-running, unsupported, rejected, and ambiguous interruption outcomes without blind retry.
- [ ] 2.4 Add real-Codex tests proving normal delivery does not interrupt tool-heavy turns and proving the exact preempt sequence before advertising the capability.

## 3. Delivery observability

- [ ] 3.1 Keep durable acceptance, runtime acceptance, explicit agent acknowledgement, and reply/task transition as distinct milestones.
- [ ] 3.2 Do not infer message observation from turn completion, elapsed time, or generic assistant output; add targeted tests.
- [ ] 3.3 Add audit/telemetry for urgency, preemption requests, authorization decisions, interruption outcomes, and subsequent direct-delivery outcomes.

## 4. OpenSpec as the single source of truth

- [ ] 4.1 Promote the still-valid TypeScript/Bun/SQLite implementation baseline from ADR-001 into the `local-service` OpenSpec capability.
- [ ] 4.2 Verify ADR-002 through ADR-008 and ADR-010 contain no still-valid normative behavior absent from canonical OpenSpec capabilities; ADR-009 is superseded by direct delivery.
- [ ] 4.3 Remove `docs/adr` after the audit and remove ADR references from canonical specs, README, and OpenSpec configuration.
- [ ] 4.4 Update repository guidance so architectural decisions are proposed only through OpenSpec and supporting docs/contracts are explicitly subordinate to it.
- [ ] 4.5 Run strict OpenSpec validation and targeted text searches proving there are no remaining normative `docs/adr` references.

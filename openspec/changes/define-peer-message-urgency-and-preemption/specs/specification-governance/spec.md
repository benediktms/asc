## ADDED Requirements

### Requirement: OpenSpec is the sole normative specification source
ACS SHALL treat `openspec/specs` as the sole normative source for behavioral and architectural requirements. Proposed requirement changes SHALL be expressed under `openspec/changes` and archived into the canonical specs through the OpenSpec workflow.

#### Scenario: Documentation conflicts with OpenSpec
- **WHEN** README, security documentation, implementation comments, typed contracts, or historical documentation conflicts with a canonical OpenSpec requirement
- **THEN** OpenSpec is authoritative and the conflicting supporting material is corrected

### Requirement: ADRs are not a parallel specification system
ACS SHALL NOT maintain normative requirements in `docs/adr`. Existing ADR content SHALL be audited before removal; any still-valid requirement not already represented in OpenSpec SHALL be promoted into an OpenSpec capability first.

#### Scenario: Existing ADR is fully represented in OpenSpec
- **WHEN** an ADR contains no unique still-valid normative requirement
- **THEN** the ADR may be deleted without creating a replacement ADR

#### Scenario: Existing ADR contains a unique valid requirement
- **WHEN** an ADR contains a still-valid architectural or behavioral requirement absent from OpenSpec
- **THEN** that requirement is added through OpenSpec before the ADR is removed

### Requirement: Supporting artifacts conform to OpenSpec
Typed contracts, threat-model documentation, README/operator documentation, tests, and implementation code SHALL conform to canonical OpenSpec requirements but SHALL NOT independently define requirements that must be consulted to understand the intended architecture.

#### Scenario: New architectural decision
- **WHEN** a change introduces or modifies a durable architectural constraint
- **THEN** the constraint is captured in the relevant OpenSpec capability rather than a new ADR

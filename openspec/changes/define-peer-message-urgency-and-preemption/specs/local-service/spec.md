## ADDED Requirements

### Requirement: Implementation baseline remains explicit in OpenSpec

ACS SHALL use TypeScript and Bun for the v1 implementation, compile to a standalone binary, persist with SQLite through Bun's native driver without an ORM, and pin the supported protocol/tool baselines in repository-controlled files.

#### Scenario: Architecture review

- **WHEN** a change proposes a different implementation language, runtime, persistence baseline, or unpinned protocol dependency
- **THEN** the change requires an explicit OpenSpec proposal rather than relying on an ADR or undocumented convention

#### Scenario: Dependency evidence

- **WHEN** the repository advertises support for a Codex or A2A protocol build
- **THEN** the supported version or revision is pinned and backed by the repository's conformance or compatibility evidence

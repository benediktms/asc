# Runtime delivery

## Purpose

Define the harness-neutral delivery boundary and safe Codex integration.
See `contracts/runtime-adapter.ts` for the typed implementation boundary.

## Requirements

### Requirement: Harness isolation

Application code SHALL depend on the harness-neutral runtime contract. Only
the Codex adapter SHALL import generated app-server protocol types.

#### Scenario: Protocol regeneration

- **WHEN** the pinned Codex protocol is regenerated
- **THEN** vendor-specific changes remain confined to the adapter boundary

### Requirement: Untrusted peer provenance

ACS SHALL deliver peer content as named tool output with untrusted peer
provenance. It SHALL NOT forge user, developer, or system messages or treat
peer content as permission to act.

#### Scenario: Peer requests privileged action

- **WHEN** a peer message contains instructions requesting permission or approval
- **THEN** the content remains untrusted and ACS grants no permission

### Requirement: Capability and policy controlled wake

Context-only delivery SHALL be supported. Codex wake SHALL require explicit
per-binding non-atomic opt-in while no atomic named tool-output queue primitive
is available. Mutations SHALL honor current binding fences.

#### Scenario: Default wake policy

- **WHEN** a wake is requested without an atomic capability or per-binding opt-in
- **THEN** ACS refuses the unsafe wake

### Requirement: Ambiguous acceptance is not blindly retried

A flushed request whose response is lost SHALL enter `acceptance-unknown`.
ACS SHALL reconcile acceptance only from authoritative evidence; an exact
named wake delivery marker can recover its owning turn. A missing marker
SHALL remain inconclusive and require audited operator resolution.

#### Scenario: Context-only delivery has no history marker

- **WHEN** reconciliation finds no authoritative evidence for an ambiguous injection
- **THEN** ACS does not automatically resend it

### Requirement: Local approvals and owned cancellation

ACS SHALL leave permission and user-input responses to the local owner and
SHALL interrupt only executions created and correlated by ACS.

#### Scenario: Fanned-out user-input request

- **WHEN** Codex sends ACS a request for local user input
- **THEN** ACS records the wait without answering the request

#### Scenario: Unrelated active turn

- **WHEN** cancellation would affect a turn not owned by ACS
- **THEN** ACS does not interrupt that turn

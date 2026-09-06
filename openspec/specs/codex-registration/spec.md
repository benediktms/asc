# Codex registration

## Purpose

Define logical-agent claims, caller identity, and safe polling for Codex sessions.
See `docs/registration.md` and `contracts/mcp-tools.ts` for the detailed API.

## Requirements

### Requirement: Host-attested caller identity

The MCP bridge SHALL derive the caller session exclusively from supported
Codex-owned metadata, never from model-supplied thread or principal IDs.

#### Scenario: Missing or ambiguous metadata

- **WHEN** caller evidence is missing, malformed, ambiguous, or unsupported
- **THEN** identity-dependent operations fail with `UNATTESTED_CALLER`

### Requirement: One-time claims and explicit rebinds

ACS SHALL store claim codes only as keyed hashes and consume them atomically
with binding creation. Replacing an active binding SHALL require explicit
consent, advance its epoch, and revoke the previous binding principal.

#### Scenario: Same-session claim retry

- **WHEN** the owning session retries a consumed claim whose binding is still active
- **THEN** the existing binding is returned

#### Scenario: Another session consumes a used claim

- **WHEN** a different session submits an already-consumed claim
- **THEN** ACS rejects it with `CLAIM_CONSUMED`

### Requirement: Polling does not lose concurrent messages

ACS SHALL allow an attested recipient to list its inbox, read a task, and
acknowledge the task together with the delivery ID returned by that read.
Acknowledgment SHALL accept only deliveries observed through that read.

#### Scenario: Follow-up arrives between read and acknowledgment

- **WHEN** a new delivery arrives after the recipient reads a task
- **THEN** acknowledgment of the previously read delivery leaves the follow-up pending

### Requirement: Registration and runtime hosting are distinct

A successful MCP identity check SHALL NOT imply that the connected app-server
hosts the caller thread. ACS SHALL defer context delivery for unloaded threads
without resuming another copy of the session.

#### Scenario: Independently launched recipient

- **WHEN** the recipient is authenticated but is not loaded on the connected app-server
- **THEN** polling remains available and automatic context delivery stays deferred

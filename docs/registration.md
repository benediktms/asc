# Codex registration and claims

## Preferred flow

The local operator creates the logical agent and a ten-minute, one-time claim:

```sh
acs agents create backend --claim
```

Inside the intended Codex session, call `acs_claim` with the returned `claimCode`.
The MCP input may also set `continuityPolicy`, `allowNonAtomicWake`, and
`revokeExisting`; it never accepts a thread, binding, principal, or sender ID.
ASC derives the runtime session exclusively from Codex-owned MCP metadata.
After a successful claim, `acs_identity` immediately reports the logical agent
and active binding epoch.

Claim codes contain 128 random bits, are stored only as keyed hashes, and are
consumed in the same SQLite transaction that creates the binding. Retrying a
consumed claim succeeds only for its still-active owning session. Another
session receives `CLAIM_CONSUMED`; an expired or unknown code receives
`CLAIM_EXPIRED` or `CLAIM_INVALID`. Replacing an active binding requires
`revokeExisting: true`, increments the binding epoch, and revokes the old
binding principal before the new principal becomes active.

Unsupported, missing, malformed, or ambiguous host evidence fails as
`UNATTESTED_CALLER` with the attestor reason. Retrying a claim after its binding
has been replaced fails as `STALE_BINDING`; attempting an implicit replacement
fails as `BINDING_CONFLICT`.

Claim creation, consumption, rejection, rebind, and explicit revocation are
audited without recording the claim code.

## Operator binding

An operator can select a discovered session without copying its opaque ID:

```sh
acs codex bind backend
```

Automation retains an explicit form:

```sh
acs codex bind backend --session <opaque-thread-id>
```

Self-registration that creates logical agents from an unbound Codex session is
disabled. It should remain disabled until caller-attestation compatibility is
proven for every supported Codex profile.

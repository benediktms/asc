# Codex compatibility profiles

ASC authorizes Codex mutations by an exact, checked-in compatibility profile. A
profile binds reviewed versions to generated app-server artifacts, their full
client-request, server-notification, and server-request schema
digest, the source package integrity, independent capability evidence, and one
caller-attestation decoder. Matching a schema is useful upgrade evidence, but it
does not authorize mutation for an unreviewed version.

The current evidence manifest is
`packages/runtime-codex/profiles/compatibility-manifest.json`. Its scenario matrix
deliberately marks forked and subagent-originated MCP calls as `unverified`; no
real-runtime claim is made for those paths. Root, resumed, app-server-managed,
and interactive TUI observations refer to the opt-in probes in
`tests/real-codex.test.ts`. Emulator coverage is not recorded as real evidence.

## Evaluate a new version

1. Install an exact `@openai/codex` version and retain its lockfile integrity.
2. Generate artifacts with `bun run generate:codex` into a new profile directory.
3. Compare old and new generated schemas, including the full server-request
   parameter and response shapes, with
   `bun run codex:diff -- <old-generated> <new-generated>`.
4. Create or update a manifest profile with the generation command, exact
   version, schema digest, package integrity, and capability evidence.
5. Run adapter/emulator tests. Then run the opt-in real tests once per capability
   marked supported, recording only the scenarios actually exercised.
6. Run `bun run check`. Review the profile and evidence change as a security
   boundary change.

An unknown version whose schema matches is reported as `candidate-compatible`.
Read-only session diagnostics remain available, while context injection, wake,
cancellation, reconciliation, and caller attestation stay disabled until the
version is added to a reviewed profile. A known version with a changed digest is
incompatible.

## Caller metadata decoder

`codex-mcp-thread-meta-v1` requires one host-owned string key, `threadId`.
Missing or malformed values fail closed. All other host metadata is ignored and
model-supplied tool arguments are never considered identity evidence. The
decoder returns only the runtime-neutral session reference and a fingerprint;
the Codex metadata object does not cross the adapter boundary.

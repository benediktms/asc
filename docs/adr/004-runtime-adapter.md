# ADR-004: Harness integration is an anti-corruption adapter

Status: accepted

The application depends on the harness-neutral runtime contract. Only the Codex adapter imports generated app-server types. Generated artifacts live under an exact compatibility profile, whose digest-verified manifest selects capabilities and the caller-attestation decoder independently. Schema similarity on an unknown build is diagnostic evidence only and never authorizes mutation.

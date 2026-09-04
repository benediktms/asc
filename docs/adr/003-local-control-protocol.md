# ADR-003: Local control uses authenticated JSON-RPC

Status: accepted

Administration, binding, diagnostics, executor callbacks, and recovery use versioned HTTP JSON-RPC over an owner-only Unix socket with scoped bearer tokens.

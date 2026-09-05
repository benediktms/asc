# ADR-001: TypeScript and Bun remain provisional

Status: accepted, with release gates open

Use TypeScript 5.9 and Bun for v1 behind phase-zero evidence. The compiled binary, SQLite, MCP initialization, HTTP, Unix sockets, pinned A2A SDK, reviewed TCK allowlist, emulated compiled app-server transport, and four-target release matrix pass in CI. A real shared Codex connection, two-build Codex attestation, and approval ownership remain release blockers.

Pinned baselines: `@a2a-js/sdk@1.1.0`, `@modelcontextprotocol/sdk@1.30.0`, Codex schema `0.153.2`, and A2A TCK `263b9cfaf16a554bdfb166a7ba5b67716e946349`.

# ADR-001: TypeScript and Bun remain provisional

Status: accepted, with release gates open

Use TypeScript 5.9 and Bun for v1 behind phase-zero evidence. The compiled binary, SQLite, MCP initialization, HTTP, and Unix sockets work locally. A2A TCK, two-build Codex attestation, compiled app-server transport, and approval ownership remain release blockers.

Pinned baselines: `@a2a-js/sdk@1.1.0`, `@modelcontextprotocol/sdk@1.30.0`, Codex schema `0.153.2`, and A2A TCK `263b9cfaf16a554bdfb166a7ba5b67716e946349`.

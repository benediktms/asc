# ADR-001: TypeScript and Bun remain provisional

Status: accepted

Use TypeScript 5.9 and Bun for v1. The compiled binary, SQLite, MCP initialization, HTTP, Unix sockets, pinned A2A SDK, reviewed TCK allowlist, emulated compiled app-server transport, and four-target release matrix pass in CI. A Codex `0.153.2` TUI launched with `--remote` and an ACS client concurrently discovered the same idle thread and delivered lifecycle notifications through one Unix-socket app-server; adapter conformance proves reconnect de-duplication. Codex `0.153.2` and `0.153.4` generate identical client and notification protocol schemas, accept the same delivery payload, and preserve host-owned MCP thread metadata for normal and resumed threads. User-routed approvals remain TUI-owned, while ACS ignores fanned-out local-input requests, completing the phase-zero evidence fail-closed.

Pinned baselines: `@a2a-js/sdk@1.1.0`, `@modelcontextprotocol/sdk@1.30.0`, Codex schema `0.153.2` (compatible build `0.153.4`), and A2A TCK `263b9cfaf16a554bdfb166a7ba5b67716e946349`.

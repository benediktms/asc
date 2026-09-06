# Direct-delivery verification

This is a supporting test/evidence record, not a second specification. The
behavioral contract is the `inject-peer-messages-into-active-turns` OpenSpec change.

## Checks that do not require user credentials

```sh
bun run typecheck
bun run lint
bun run format:check
bun run boundaries
bun run enums:check
bun run codex:check
mise run specs:check
bun test tests/config.test.ts tests/storage.test.ts tests/a2a.test.ts tests/control.test.ts tests/scheduler.test.ts tests/runtime-adapter-conformance.test.ts tests/app-server-client.test.ts tests/packaging.test.ts tests/mcp.test.ts tests/cli.test.ts
bun run test:codex-real
```

The full suite and A2A TCK run in CI. The native CI matrix selects Codex `0.153.2`
and `0.153.4` independently of schema generation, which remains pinned to `0.153.2`.

The native test uses an actual Codex executable, two independent app-server
clients on one Unix socket, a fresh isolated HOME/CODEX_HOME, and a local mocked
Responses API. It never loads user authentication. It verifies:

- Input starts a fresh idle thread, including one without a persisted rollout.
- Two additional messages join that same active turn while its model response
  is deliberately held. Acceptance precedes their inclusion in the next model
  HTTP request; there is no claim of instantaneous observation.
- Each message remains a named function output in the `acs` namespace, not a
  forged local-user/developer/system item.
- Context-only empty-input `turn/steer` is rejected without merging its content.
- Each delivery ID/payload hash can be reconciled to the correct persisted turn;
  conflicting evidence remains inconclusive.
- Attaching for notifications is separate from admitting input. Listener/read
  failure after an accepted submission must not cause input resubmission.
- The shared adapter refuses cancellation as evidence of exclusive execution
  ownership is absent.

Fake-adapter and transport tests additionally cover lease recovery, aborts and
lost responses, malformed success responses, capability reductions, exact binding
fences, foreign-thread notifications, shared task isolation, explicit completion,
and cancellation that does not starve unrelated work. Compiled-binary tests run
without a Bun executable in PATH and exercise MCP, A2A, CLI, and persistence.

## Evidence still requiring a live interactive setup

The optional `bun run test:codex-model` uses configured Codex authentication and
real inference. It is an idle-message semantic smoke test, not a replacement for
this operator-driven matrix:

1. Attach ACS and an actual TUI/desktop client to the same live thread; do not
   resume a second copy elsewhere.
2. Deliver while idle, while tools are running, and at a turn boundary. Verify
   the recipient replies to the right task without manual relay.
3. Exercise local approvals and user-input requests. Verify ACS never answers or
   bypasses them and the interactive client remains the human owner.
4. Reconnect each client and drop the delivery connection after write. Verify
   exact-marker reconciliation or explicit uncertainty, never duplicate submission.
5. Observe the UI independently of model input: native function output does not
   promise a particular desktop message-card presentation.

No authenticated model or human-interactive matrix result is claimed by the
credential-free test run. The urgency/preemption follow-up is not implemented or
certified by this branch.

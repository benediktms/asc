## Context

See `proposal.md` for motivation. The current runtime adapter uses `thread/inject_items` for history-only delivery and `turn/start` for opt-in wake delivery. The service has not been used in production, so this change should update the initial contract and storage model directly rather than introduce compatibility or migration machinery for unused state.

Codex already exposes the primitive we need for live cross-thread delivery: `turn/start` accepts empty user input plus named `toolOutput`. First-party Codex cross-thread tooling uses this shape to preserve tool authority. On a supported active regular turn, app-server may accept the same request into that turn; on an idle thread it starts a new turn. The adapter must record which relationship actually occurred rather than inferring ownership from the method name.

The pinned Codex protocol also exposes `turn/steer` with `expectedTurnId` and `additionalContext`. However, the pinned upstream implementation explicitly rejects context-only steering with empty `input` (`input must not be empty`). Therefore this change does not rely on `turn/steer` for peer messages: fabricating a `UserInput` item would incorrectly present peer content as local-user authority.

The adapter currently connects to one configured app-server, so a bound thread is directly reachable only when that server owns or hosts it.

## Goals / Non-Goals

**Goals:**

- Put peer messages into the model-visible input path of the recipient Codex session without waiting for a future user turn.
- Preserve peer/tool provenance and local ownership of approvals and user input.
- Keep durable acceptance distinct from runtime acceptance and from agent acknowledgement/reply.
- Give every direct attempt an exact delivery marker and correlate it with the runtime turn that accepted it.
- Permit several peer messages to be accepted into one active turn without conflating their task or reply lifecycles.

**Non-Goals:**

- Taking ownership of Codex approvals, user-input requests, settings, or cancellation for user-owned turns.
- Claiming that runtime acceptance means the model has read, understood, or replied to a message.
- Resuming a second copy of a thread whose owning app-server is unknown.
- Treating inbox reads or history append as successful automatic delivery.
- Preserving unused legacy delivery modes or adding rollback/migration machinery before the service has users.

## Decisions

### Use named tool-output start-or-join delivery for reachable sessions

For a reachable bound Codex thread, the adapter submits `turn/start` with:

- `input: []`;
- `toolOutput.name = "receive_agent_message"`;
- `toolOutput.namespace = "acs"`;
- `toolOutput.output = <canonical delivery envelope>`.

The canonical envelope contains the durable delivery/message identity, authenticated sender identity, optional task correlation, reply contract, and peer-agent provenance.

This is a **session-addressed** delivery guarantee rather than an exact previously-observed-turn precondition. If the recipient is idle, Codex starts a new turn. If Codex accepts the submission into an already-active supported turn, ACS records that existing turn. If the runtime cannot accept the input in the current state, ACS defers the delivery rather than appending it to history or fabricating a local-user message.

This behavior is preferred over `turn/steer` because the pinned Codex implementation rejects empty-input, additional-context-only steering. Supplying non-empty `UserInput` merely to satisfy `turn/steer` is rejected as a design because it changes the authority of peer content.

### Preserve peer provenance

A peer message is external agent input, not local-user authority. ACS SHALL NOT represent peer content as user, developer, or system input.

Named tool output provides the initial Codex representation. Runtime adapters for other harnesses may use different native message/input primitives, but they MUST preserve an equivalent trust boundary and MUST NOT upgrade peer content into permission-granting authority.

### Record the actual execution relationship

A method named `turn/start` does not prove that ACS created a new dedicated turn. Runtime acceptance SHALL capture the relationship when the runtime can establish it:

```text
started   - this delivery started a new turn
joined    - this delivery was accepted into an existing active turn
unknown   - the runtime accepted the input but ACS cannot prove which relationship applies
```

The returned/observed turn identifier is runtime evidence for delivery. It is not ownership of the whole turn.

The adapter MUST NOT mark `joined` as `started` merely because it issued `turn/start`.

### Defer when direct delivery is unavailable

Dormant, unloaded, offline, locally-blocked, stale, and unsupported targets remain pending with a precise reason. The scheduler retries from fresh runtime state. It never downgrades to history append.

A target binding must resolve to an app-server route that can mutate the bound live thread; shared-endpoint setup or ACS-owned runtime creation supplies that route. Automatically resuming an unreachable thread on another app-server is rejected because ACS cannot prove that a separate live owner is absent.

### Model many deliveries to one runtime turn

One active turn may accept several delivery IDs:

```text
message A ---\
message B ----+--> runtime turn X
message C ---/
```

Persistence therefore models a many-to-one association between delivery attempts and runtime turns/executions.

Each message/task retains its own sender, delivery identity, optional task identity, and reply expectation. A runtime turn's final assistant output MUST NOT be attributed wholesale to all deliveries associated with the turn.

### Task completion is always explicit

Runtime execution completion and A2A task completion are separate state changes.

For **all** delegated tasks, including a task whose first message caused Codex to start a new turn, terminal task state requires a task-specific action such as:

- `acs_task_complete`;
- `acs_task_fail`;
- `acs_task_request_input` for a non-terminal wait;
- requester cancellation resolved through the task contract.

A `turn/completed` event records runtime execution completion and may capture useful output, but it SHALL NOT automatically complete the associated A2A task.

This removes fragile ownership inference once additional peer messages can join the same turn.

### Task cancellation does not imply turn interruption

Canceling one peer task MUST NOT automatically interrupt a runtime turn that may contain unrelated local work or other peer tasks.

Runtime interruption is permitted only when ACS can prove it owns an isolated execution and policy explicitly allows interruption. Otherwise cancellation changes the task/delivery state and the agent is informed through the normal message/task protocol without terminating the shared turn.

### Replace delivery mode selection with `direct`

New A2A and MCP sends create direct delivery intents without caller-selected `wake_when_idle`, `append_context`, or `join_active` behavior.

Because ACS has no deployed compatibility obligation yet, the initial schema, contracts, configuration, and fixtures SHOULD be changed directly to the `direct` model. No legacy-row rewrite or rollback compatibility layer is required.

## Runtime acceptance and reply semantics

Successful communication has multiple independently observable milestones:

```text
1. durable acceptance by ACS
2. runtime acceptance by the destination session
3. optional agent acknowledgement
4. explicit reply / task state transition
```

The service SHALL NOT collapse these milestones.

A successful app-server response establishes runtime acceptance only to the extent proven by its turn identifier and subsequent runtime evidence. It does not prove that the receiving model has acted on the content.

Replies SHALL correlate to the specific task/message contract rather than relying on the latest runtime turn or forwarding an arbitrary final assistant response.

## Ambiguous writes

A request known to have been flushed but whose response is lost enters `acceptance-unknown`.

ACS SHALL NOT blindly resubmit it. Reconciliation should use authoritative runtime evidence containing the exact delivery marker and accepted turn where the selected Codex profile makes this possible. If acceptance or non-acceptance cannot be proven, the state remains explicitly inconclusive for audited resolution.

The direct-delivery envelope MUST carry a stable delivery ID and payload hash so recovered evidence can be checked for identity conflicts.

## Risks / Trade-offs

- **Session-addressed rather than exact-turn conditional delivery** -> A message may join a different active regular turn than a stale preflight inspection observed. This is acceptable for normal peer messaging because the target is the agent session, not a particular inference turn. Exact-turn delivery remains a separate capability if Codex later exposes a provenance-preserving conditional primitive.
- **Some active Codex states may reject start-or-join input** -> Keep the message pending and retry after state changes; never append it silently.
- **A recipient session is hosted by another app-server** -> Report route unavailable and require a shared endpoint or ACS-owned attachment before automatic delivery can succeed.
- **A response is lost after write** -> Reconcile from exact marker/turn evidence when possible; otherwise retain `acceptance-unknown`.
- **Several tasks share one active turn** -> Require explicit task actions and do not infer results from the shared final response.
- **Shared-turn cancellation** -> Do not interrupt the whole turn unless isolated ACS ownership is proven.

## Implementation sequencing

1. Update the runtime/A2A/MCP/control contracts to one `direct` delivery behavior.
2. Implement typed named-tool-output start-or-join submission in the Codex anti-corruption layer and preserve the returned/observed turn ID.
3. Extend runtime correlation persistence to support many deliveries per turn and record `started | joined | unknown` where evidence permits.
4. Remove automatic task completion from `turn/completed`; require explicit terminal task operations.
5. Harden cancellation so a peer task cannot interrupt unrelated shared-turn work.
6. Prove idle and active delivery, local-input behavior, multi-message correlation, and ambiguous-write handling against real Codex before advertising the capability for a profile.
7. Rebase or supersede open branches that encode the old append/wake split.

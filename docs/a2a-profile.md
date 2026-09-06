# ASC A2A profile v1

Status: normative for ASC `0.1.x`  
Profile identifier: `asc-a2a-v1`  
A2A protocol version: `1.0`

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are interpreted as
described by RFC 2119. This document defines ASC's supported subset of the A2A
v1 protocol and its extension points. The machine-readable conformance metadata,
including the single pinned TCK revision, is in
[`conformance/a2a-profile-v1.json`](../conformance/a2a-profile-v1.json).

## Binding and routing

ASC implements the A2A v1 JSON-RPC binding over loopback HTTP. It does not
implement the HTTP+JSON/REST or gRPC bindings.

Each logical agent has two routes:

- `GET /agents/{agent-slug}/.well-known/agent-card.json`
- `POST /agents/{agent-slug}/a2a`

The Agent Card's JSON-RPC interface URL points at the second route. The agent in
the URL is the target agent. Clients MUST NOT rely on a proprietary recipient
field in the A2A `Message`; ASC derives no routing authority from message
content.

The Agent Card route is public on the loopback listener. Disabled and unknown
agents return HTTP 404. Cards advertise protocol version `1.0`, JSON-RPC,
streaming, authenticated extended cards, no push notifications, default input
and output mode `text/plain`, and the optional ASC delivery extension.

## Authentication and visibility

Every JSON-RPC request MUST use `Authorization: Bearer <opaque-token>`. Tokens
are local ASC credentials and carry `a2a:send`, `a2a:read`, and/or `a2a:cancel`
scopes. Administrative control-plane tokens are not valid A2A credentials.

Task reads, cancellation, continuation, listing, and subscription are restricted
to both the original requester principal and the target-agent route. ASC returns
`TaskNotFoundError` for absent and non-visible task IDs so callers cannot use the
error surface to enumerate another principal's tasks.

## Operations

| Operation                               | v1 behavior                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SendMessage`                           | Supported. Always creates or continues a durable `Task`; ASC does not return the optional direct `Message` response. |
| `SendStreamingMessage`                  | Supported. The first SSE event is the accepted Task snapshot, followed by ordered status updates.                    |
| `GetTask`                               | Supported, including `historyLength`.                                                                                |
| `ListTasks`                             | Supported, with filters, opaque pagination tokens, history truncation, and optional artifact inclusion.              |
| `CancelTask`                            | Supported and idempotent for an already-canceled task. Other terminal tasks return `TaskNotCancelableError`.         |
| `SubscribeToTask`                       | Supported. Sends the authoritative current Task first and then events after that snapshot's sequence boundary.       |
| `GetExtendedAgentCard`                  | Supported for authenticated callers; currently returns the same fields as the public card.                           |
| Push-notification configuration methods | Unsupported and return `PushNotificationNotSupportedError`.                                                          |

The private Unix-socket control protocol and the Codex MCP tools are not A2A
operations. They administer agents and bindings or translate an authenticated
local tool call into this A2A profile.

## Message execution and task state

`SendMessage` follows `SendMessageConfiguration.returnImmediately`:

- `true`: return the accepted Task immediately, normally in `submitted` state;
- `false` or absent: wait until the Task is terminal (`completed`, `failed`,
  `canceled`, or `rejected`) or interrupted (`input-required` or
  `auth-required`).

`SendStreamingMessage` is the asynchronous streaming form and begins with the
accepted Task without waiting. Both streaming operations close their storage
subscription when the task becomes terminal or the client disconnects.
Interrupted states end a synchronous `SendMessage` response, but do not end a
subscription because a later client message may resume the same Task.

ASC persists an append-only sequence of task events. A subscription captures an
authoritative Task and sequence in one storage read, emits that Task, then polls
only for events after that boundary. A subscription to a terminal Task emits the
current Task and terminates without opening a polling loop.

## History and listing

`historyLength` is a non-negative upper bound. Zero returns an empty history;
positive values return the newest messages in chronological order. Omission
returns all persisted history. `SendMessage` applies the same truncation to its
response without changing durable history.

`ListTasks.pageSize` defaults to 50 and is clamped to 1–100. `nextPageToken` is
an opaque storage cursor and an empty string means there is no next page. A
token is valid only with the same requester and target-agent visibility scope.

## Content profile

ASC accepts:

- text parts as `text/plain` or `text/markdown`;
- URL parts, retaining their declared media type and filename;
- structured data parts, defaulting to `application/json`.

Inline raw-byte parts and unknown part variants are unsupported and return
`ContentTypeNotSupportedError`. Cards conservatively advertise only
`text/plain` as the default input and output mode. Artifacts produced by the
runtime may contain valid A2A text, URL, or data parts; ASC does not promise that
a request will produce an artifact or a particular artifact shape.

## Delivery extension

`urn:agent-communications:delivery:v1` is an optional request-metadata extension.
Its schema is [`contracts/delivery-extension.schema.json`](../contracts/delivery-extension.schema.json).
It selects `wake_when_idle` or `append_context` delivery and carries priority,
notification, reply, and expiry preferences. It does not select the recipient.

Responses may include `urn:agent-communications:delivery-status:v1` metadata.
That metadata reports ASC's durable delivery identifier/state and whether this
response came from an idempotent duplicate. Both URIs are versioned separately
from A2A; incompatible changes require a new URI.

## Idempotency

`Message.messageId` is the idempotency key within `(requester principal, target
agent)`. The canonical request covers task/context IDs, role, parts, request and
message metadata, and delivery preferences.

- Repeating the same key and canonical request returns the current Task and the
  original delivery ID without enqueuing another delivery.
- Reusing the key for different content returns non-retryable
  `ACS_IDEMPOTENCY_CONFLICT`.

This rule is deliberately stricter than treating a message ID as a best-effort
deduplication hint. It MUST NOT be weakened to accommodate a test fixture that
reuses an ID for different requests.

## Errors and retries

Protocol-defined conditions use the A2A v1 JSON-RPC error codes supplied by the
pinned SDK, including `TaskNotFoundError`, `TaskNotCancelableError`,
`ContentTypeNotSupportedError`, `PushNotificationNotSupportedError`,
`UnsupportedOperationError`, and `VersionNotSupportedError`.

ASC domain failures use JSON-RPC code `-32010`. `error.data` includes a stable
ASC code, `retryable`, and a correlation ID. Only transient storage failure and
overload are retryable. Validation, visibility, task-state, unsupported-content,
and idempotency failures are not. Overload also returns HTTP 429; valid JSON-RPC
application errors otherwise use HTTP 200. HTTP routing, authentication,
content-type, and body-limit failures use their ordinary HTTP status codes.

## Conformance policy

The pinned TCK runs MUST-level JSON-RPC tests. Every expected failure MUST have
a requirement level, classification, specification citation, evidence, decision,
and objective review condition in the profile manifest. CI fails on either a new
failure or an expected failure that begins passing, so exceptions cannot expand
or become stale silently. The CI artifact contains the upstream compatibility
report plus concise JSON and Markdown summaries.

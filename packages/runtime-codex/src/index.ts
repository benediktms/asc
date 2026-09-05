import type { ResponseItem } from "../../codex-protocol-generated/src/ResponseItem";
import type { JsonValue } from "../../codex-protocol-generated/src/serde_json/JsonValue";
import type {
  RuntimeAdapter,
  RuntimeAdapterContext,
  RuntimeAdapterDescriptor,
  RuntimeAdapterStopContext,
  RuntimeAvailability,
  RuntimeCapabilities,
  RuntimeCancelRequest,
  RuntimeCancelResult,
  RuntimeDeliveryEnvelopeV1,
  DeliveryId,
  RuntimeDeliveryRequest,
  RuntimeDeliveryResult,
  RuntimeEvent,
  NeutralPart,
  RuntimeProbeResult,
  RuntimeReconcileRequest,
  RuntimeReconcileResult,
  RuntimeSessionPage,
  RuntimeSessionQuery,
  RuntimeSessionRef,
  RuntimeSessionSnapshot,
} from "../../../contracts/runtime-adapter";
import { CodexAppServerClient, type CodexThread } from "./app-server-client";
import { telemetry } from "../../observability/src/index";
import testedVersion from "../../codex-protocol-generated/CODEX_VERSION" with { type: "text" };

export const TESTED_CODEX_VERSION = testedVersion.trim();

export function codexVersion(value: string): string | undefined {
  return value.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.at(0);
}

const capabilities: RuntimeCapabilities = {
  listSessions: true,
  observeSessionState: true,
  observeExecutions: true,
  appendContext: true,
  wakeWhenIdle: true,
  atomicDeferredWake: false,
  steerActiveExecution: false,
  cancelOwnedExecution: true,
  reconcileDelivery: true,
  callerAttestationSchemes: ["codex-mcp-thread-meta-v1"],
  supportedPartKinds: ["text", "uri", "data"],
};
const disabledCapabilities = (): RuntimeCapabilities => ({
  ...capabilities,
  appendContext: false,
  wakeWhenIdle: false,
  cancelOwnedExecution: false,
  reconcileDelivery: false,
});
const availabilityStates: RuntimeAvailability[] = [
  "unknown",
  "offline",
  "dormant",
  "idle",
  "busy",
  "awaiting-local-input",
  "degraded",
];

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor = {
    adapterApiVersion: 1,
    adapterId: "codex.app-server",
    harnessId: "codex",
    implementationVersion: "0.1.0",
    capabilities,
  };
  private client?: CodexAppServerClient;
  private context?: RuntimeAdapterContext;
  private stopped = false;
  private runtimeVersion?: string;
  private events: RuntimeEvent[] = [];
  private waiters: Array<() => void> = [];
  private executions = new Map<
    string,
    {
      deliveryId: DeliveryId;
      payloadHash: string;
      session: RuntimeSessionRef;
      finalParts: NeutralPart[];
    }
  >();

  constructor(
    readonly socketPath: string,
    readonly maxInFlightRequests = 128,
  ) {}

  async start(context: RuntimeAdapterContext) {
    if (this.client) return;
    this.context = context;
    this.stopped = false;
    const client = new CodexAppServerClient(
      this.socketPath,
      10_000,
      1_000,
      this.maxInFlightRequests,
    );
    this.client = client;
    client.onNotification = (method, params) => this.handleNotification(method, params);
    client.onRequest = (requestId, method, params) =>
      this.handleRequest(String(requestId), method, params);
    client.onClose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.runtimeVersion = undefined;
      if (!this.stopped) this.emit({ type: "adapter.connection", state: "offline" });
    };
    try {
      const initialized = await client.start();
      this.runtimeVersion = codexVersion(initialized.userAgent);
    } catch (error) {
      client.close();
      if (this.client === client) this.client = undefined;
      throw error;
    }
    this.emit({ type: "adapter.connection", state: "online" });
  }
  async stop(_context: RuntimeAdapterStopContext) {
    this.stopped = true;
    this.client?.close();
    this.client = undefined;
    this.runtimeVersion = undefined;
    this.wake();
  }
  async probe(): Promise<RuntimeProbeResult> {
    try {
      if (!this.client) throw new Error("adapter not started");
      await this.client.listThreads({ limit: 1, useStateDbOnly: true });
      if (this.runtimeVersion !== TESTED_CODEX_VERSION)
        return {
          state: "incompatible",
          observedAt: new Date().toISOString(),
          runtimeVersion: this.runtimeVersion,
          capabilities: disabledCapabilities(),
          diagnostics: [
            {
              severity: "error",
              code: "CODEX_VERSION_UNTESTED",
              message: `Expected Codex ${TESTED_CODEX_VERSION}, received ${this.runtimeVersion ?? "unknown"}`,
            },
          ],
        };
      return {
        state: "ready",
        observedAt: new Date().toISOString(),
        runtimeVersion: this.runtimeVersion,
        capabilities,
        diagnostics: [
          {
            severity: "warning",
            code: "NON_ATOMIC_WAKE_ONLY",
            message:
              "Codex queue input cannot preserve named tool-output provenance; wake requires explicit non-atomic policy.",
          },
        ],
      };
    } catch (error) {
      return {
        state: "unavailable",
        observedAt: new Date().toISOString(),
        capabilities: disabledCapabilities(),
        diagnostics: [
          {
            severity: "error",
            code: "CODEX_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
  async listSessions(query: RuntimeSessionQuery): Promise<RuntimeSessionPage> {
    const client = this.requireClient(),
      loaded = await client.loadedThreads(),
      page = await client.listThreads({
        cursor: query.cursor,
        limit: Math.min(query.limit ?? 50, 100),
        searchTerm: query.text,
        useStateDbOnly: true,
      }),
      stored = new Set(page.data.map((thread) => thread.id)),
      loadedSnapshots = await Promise.all(
        loaded.data
          .filter((threadId) => !stored.has(threadId))
          .map((threadId) =>
            this.inspectSession({
              installationId: this.requireContext().installationId,
              opaqueId: threadId,
            }),
          ),
      );
    let sessions = [
      ...loadedSnapshots.filter((session) => session.availability !== "offline"),
      ...page.data.map((thread) => this.snapshot(thread)),
    ];
    if (query.text) {
      const search = query.text.toLocaleLowerCase();
      sessions = sessions.filter((session) =>
        Object.values(session.attributes).some((value) =>
          typeof value === "string" ? value.toLocaleLowerCase().includes(search) : false,
        ),
      );
    }
    const availability = query.availability;
    if (availability?.length)
      sessions = sessions.filter((item) => availability.includes(item.availability));
    for (const state of availabilityStates)
      telemetry.gauge(
        "acs_runtime_sessions_by_state",
        sessions.filter((session) => session.availability === state).length,
        { state },
      );
    return { sessions, nextCursor: page.nextCursor ?? undefined };
  }
  async inspectSession(session: RuntimeSessionRef): Promise<RuntimeSessionSnapshot> {
    return telemetry.trace("runtime.inspect", async () => {
      try {
        return this.snapshot(
          (
            await this.requireClient().readThread({
              threadId: session.opaqueId,
              includeTurns: false,
            })
          ).thread,
        );
      } catch (error: unknown) {
        if (
          /not found|invalid thread|adapter not started|not connected|connection (?:closed|reset)|socket unavailable/i.test(
            errorMessage(error),
          )
        )
          return {
            session,
            availability: "offline",
            observedAt: new Date().toISOString(),
            attributes: {},
          };
        throw error;
      }
    });
  }
  async *observe(signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    while (!this.stopped && !signal.aborted) {
      if (this.events.length) {
        const event = this.events.shift();
        if (event) yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        const abort = () => resolve();
        signal.addEventListener("abort", abort, { once: true });
        this.waiters.push(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
  }
  async deliver(request: RuntimeDeliveryRequest): Promise<RuntimeDeliveryResult> {
    if (!this.supports(request.envelope))
      return { outcome: "rejected", reason: "unsupported-content", retryable: false };
    if (request.deadline && Date.parse(request.deadline) <= Date.now())
      return {
        outcome: "rejected",
        reason: "runtime-protocol-error",
        retryable: false,
        details: { deadline: "expired" },
      };
    if (request.mode === "join_active")
      return { outcome: "rejected", reason: "unsupported-mode", retryable: false };
    const snapshot = await this.inspectSession(request.target.session);
    if (snapshot.availability === "offline") return { outcome: "deferred", reason: "offline" };
    if (this.runtimeVersion !== TESTED_CODEX_VERSION)
      return { outcome: "rejected", reason: "runtime-protocol-error", retryable: false };
    if (request.mode === "wake_when_idle") {
      if (snapshot.availability === "dormant") {
        if (!request.autoResumeDormantThread) return { outcome: "deferred", reason: "dormant" };
      } else if (snapshot.availability !== "idle")
        return {
          outcome: "deferred",
          reason:
            snapshot.availability === "busy" || snapshot.availability === "awaiting-local-input"
              ? "busy"
              : "policy",
        };
    }
    const fence = await this.requireContext().assertBindingFence(
      request.target.bindingId,
      request.target.bindingEpoch,
    );
    if (!fence.valid) return { outcome: "rejected", reason: "stale-binding", retryable: false };
    try {
      if (request.mode === "append_context") {
        await this.requireClient().injectItems(
          {
            threadId: request.target.session.opaqueId,
            items: [jsonValue(JSON.stringify(this.responseItem(request.envelope)))],
          },
          request.markRequestFlushed,
        );
        return {
          outcome: "accepted",
          acceptedAt: new Date().toISOString(),
          evidence: { scheme: "codex.thread-inject-items.v1", value: request.deliveryId },
        };
      }
      await this.requireClient().resumeThread(request.target.session.opaqueId);
      const response = await this.requireClient().startTurn(
        {
          threadId: request.target.session.opaqueId,
          input: [],
          turnTrigger: "agent-communications-service",
          toolOutput: {
            name: "receive_agent_message",
            namespace: "acs",
            output: JSON.stringify(request.envelope),
          },
        },
        request.markRequestFlushed,
      );
      this.executions.set(response.turn.id, {
        deliveryId: request.deliveryId,
        payloadHash: request.payloadHash,
        session: request.target.session,
        finalParts: [],
      });
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: response.turn.id, alreadyRunning: false },
        evidence: { scheme: "codex.turn-start.v1", value: response.turn.id },
      };
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (/timeout|connection closed|reset/i.test(message))
        return {
          outcome: "acceptance-unknown",
          ambiguity: "connection-reset",
          reconciliationToken: `${request.target.session.opaqueId}:${request.deliveryId}`,
        };
      if (/overload|queue.*full|too many/i.test(message))
        return { outcome: "deferred", reason: "backpressure", retryAfterMs: 1000 };
      if (/not found/i.test(message))
        return { outcome: "rejected", reason: "session-not-found", retryable: false };
      return {
        outcome: "rejected",
        reason: "runtime-protocol-error",
        retryable: false,
        details: { code: errorCode(error) },
      };
    }
  }
  async reconcile(request: RuntimeReconcileRequest): Promise<RuntimeReconcileResult> {
    if (this.runtimeVersion !== TESTED_CODEX_VERSION)
      return {
        outcome: "inconclusive",
        reason: "Codex runtime version is not supported",
        operatorActionRequired: true,
      };
    if (request.reconciliationToken !== `${request.target.session.opaqueId}:${request.deliveryId}`)
      return {
        outcome: "inconclusive",
        reason: "invalid Codex reconciliation token",
        operatorActionRequired: true,
      };
    try {
      const marker = await this.requireClient().findDeliveryMarker(
        request.target.session.opaqueId,
        request.deliveryId,
      );
      return marker
        ? {
            outcome: "accepted",
            execution: { opaqueId: marker.turnId },
            evidence: {
              scheme: "codex.function-call-output.v1",
              value: request.deliveryId,
            },
          }
        : {
            outcome: "inconclusive",
            reason: "Codex history does not contain a durable wake marker",
            operatorActionRequired: true,
          };
    } catch (error: unknown) {
      return {
        outcome: "inconclusive",
        reason: errorMessage(error),
        operatorActionRequired: true,
      };
    }
  }
  async cancel(request: RuntimeCancelRequest): Promise<RuntimeCancelResult> {
    if (this.runtimeVersion !== TESTED_CODEX_VERSION)
      return { outcome: "rejected", reason: "runtime-protocol-error", retryable: false };
    if (!this.executions.has(request.execution.opaqueId))
      return { outcome: "rejected", reason: "not-owned", retryable: false };
    const fence = await this.requireContext().assertBindingFence(
      request.execution.bindingId,
      request.execution.bindingEpoch,
    );
    if (!fence.valid) return { outcome: "rejected", reason: "stale-binding", retryable: false };
    try {
      await this.requireClient().interruptTurn(
        request.execution.session.opaqueId,
        request.execution.opaqueId,
      );
      return { outcome: "accepted", acceptedAt: new Date().toISOString() };
    } catch (error: unknown) {
      const message = errorMessage(error);
      return /not running|not found/i.test(message)
        ? { outcome: "not-running" }
        : { outcome: "unknown", reason: message };
    }
  }
  private snapshot(thread: CodexThread): RuntimeSessionSnapshot {
    return {
      session: { installationId: this.requireContext().installationId, opaqueId: thread.id },
      availability: status(thread),
      observedAt: new Date().toISOString(),
      revision: String(thread.updatedAt),
      attributes: {
        displayTitle: thread.name ?? thread.preview,
        cwdHint: thread.cwd,
        sourceKind:
          typeof thread.source === "string" ? thread.source : JSON.stringify(thread.source),
      },
    };
  }
  private responseItem(envelope: RuntimeDeliveryEnvelopeV1): ResponseItem {
    return {
      type: "function_call_output",
      name: "receive_agent_message",
      namespace: "acs",
      output: JSON.stringify(envelope),
    };
  }
  private supports(envelope: RuntimeDeliveryEnvelopeV1) {
    return (envelope.message?.parts ?? envelope.event?.parts ?? []).every(
      (part) => part.kind === "text" || part.kind === "uri" || part.kind === "data",
    );
  }
  private requireClient() {
    if (!this.client || this.stopped) throw new Error("adapter not started");
    return this.client;
  }
  private requireContext() {
    if (!this.context) throw new Error("adapter not started");
    return this.context;
  }
  private emit(event: RuntimeEvent) {
    this.events.push(event);
    this.wake();
  }
  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  private handleNotification(method: string, params: unknown) {
    if (method === "thread/status/changed" && isThreadStatusChanged(params)) {
      const session = {
        installationId: this.requireContext().installationId,
        opaqueId: params.threadId,
      };
      this.emit({
        type: "session.observed",
        session,
        snapshot: {
          session,
          availability: statusType(params.status),
          observedAt: new Date().toISOString(),
          attributes: {},
        },
      });
    }
    if (method === "turn/started" && isTurnStarted(params)) {
      const execution = this.executions.get(params.turn.id);
      if (execution)
        this.emit({
          type: "execution.started",
          session: execution.session,
          execution: { opaqueId: params.turn.id, session: execution.session },
          correlation: {
            deliveryId: execution.deliveryId,
            payloadHash: execution.payloadHash,
          },
        });
    }
    if (method === "item/completed" && isItemCompleted(params)) {
      const event = params,
        execution = this.executions.get(event.turnId);
      if (
        execution &&
        event.item.type === "agentMessage" &&
        "text" in event.item &&
        typeof event.item.text === "string"
      ) {
        const item = event.item;
        execution.finalParts = [{ kind: "text", text: item.text, mediaType: "text/markdown" }];
        this.emit({
          type: "execution.output",
          execution: { opaqueId: event.turnId, session: execution.session },
          channel: "final-message",
          parts: execution.finalParts,
        });
      }
    }
    if (method === "turn/completed" && isTurnCompleted(params)) {
      const event = params,
        execution = this.executions.get(event.turn.id);
      if (execution) {
        const outcome =
          event.turn.status === "completed"
            ? "completed"
            : event.turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        this.emit({
          type: "execution.completed",
          execution: { opaqueId: event.turn.id, session: execution.session },
          outcome,
          finalParts: execution.finalParts,
        });
        this.executions.delete(event.turn.id);
      }
    }
  }
  private handleRequest(requestId: string, method: string, params: unknown) {
    if (!isRuntimeInputRequest(params)) return;
    const execution = this.executions.get(params.turnId);
    if (!execution) return;
    this.emit({
      type: "execution.awaiting-local-input",
      execution: { opaqueId: params.turnId, session: execution.session },
      request: {
        opaqueId: requestId,
        kind:
          method === "item/tool/requestUserInput"
            ? "question"
            : method.endsWith("/requestApproval")
              ? "approval"
              : "unknown",
        blocking: params.isBlocking !== false,
        summary: "Local runtime input required",
      },
    });
  }
}

function jsonValue(json: string): JsonValue {
  const value: unknown = JSON.parse(json);
  if (!isJsonValue(value)) throw new Error("runtime envelope is not JSON");
  return value;
}
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.values(value).every((item) => item === undefined || isJsonValue(item))
  );
}
function isItemCompleted(
  value: unknown,
): value is { turnId: string; item: { type: "agentMessage"; text: string } | { type: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "turnId" in value &&
    typeof value.turnId === "string" &&
    "item" in value &&
    typeof value.item === "object" &&
    value.item !== null &&
    "type" in value.item &&
    typeof value.item.type === "string" &&
    (value.item.type !== "agentMessage" ||
      ("text" in value.item && typeof value.item.text === "string"))
  );
}
function isTurnCompleted(
  value: unknown,
): value is { turn: { id: string; status: "completed" | "interrupted" | string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "turn" in value &&
    typeof value.turn === "object" &&
    value.turn !== null &&
    "id" in value.turn &&
    typeof value.turn.id === "string" &&
    "status" in value.turn &&
    typeof value.turn.status === "string"
  );
}

function isTurnStarted(value: unknown): value is { threadId: string; turn: { id: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    "turn" in value &&
    typeof value.turn === "object" &&
    value.turn !== null &&
    "id" in value.turn &&
    typeof value.turn.id === "string"
  );
}

function isRuntimeInputRequest(value: unknown): value is { turnId: string; isBlocking?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "turnId" in value &&
    typeof value.turnId === "string" &&
    (!("isBlocking" in value) || typeof value.isBlocking === "boolean")
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown";
}
function isThreadStatusChanged(
  value: unknown,
): value is { threadId: string; status: { type: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    "status" in value &&
    typeof value.status === "object" &&
    value.status !== null &&
    "type" in value.status
  );
}

function status(thread: CodexThread): RuntimeAvailability {
  return statusType(thread.status);
}
function statusType(value: { type: string }): RuntimeAvailability {
  switch (value.type) {
    case "idle":
      return "idle";
    case "active":
      return "busy";
    case "notLoaded":
      return "dormant";
    case "systemError":
      return "degraded";
    default:
      return "unknown";
  }
}

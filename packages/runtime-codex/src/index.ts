import { createHash } from "node:crypto";
import {
  CodexAppServerError,
  CodexAppServerFailureKind,
  type CodexAppServerFailureDto,
  type CodexThreadDto,
} from "../../../contracts/codex-app-server-boundary";
import type {
  CallerAttestationResult,
  HostInvocationEvidence,
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
  RuntimeInstallationId,
  RuntimeProbeResult,
  RuntimeReconcileRequest,
  RuntimeReconcileResult,
  RuntimeCallerAttestor,
  RuntimeSessionPage,
  RuntimeSessionQuery,
  RuntimeSessionRef,
  RuntimeSessionSnapshot,
} from "../../../contracts/runtime-adapter";
import { CodexAppServerClient } from "./app-server-client";
import { telemetry } from "../../observability/src/index";
import {
  CODEX_PROTOCOL_FINGERPRINT,
  CODEX_COMPATIBILITY_PROFILES,
  profileCapabilities,
  selectCodexCompatibility,
  type CodexCompatibilitySelection,
} from "./compatibility";
import { createCodexProtocolCodec, jsonValue } from "./protocol-codec";

export {
  CODEX_COMPATIBILITY_PROFILES,
  CODEX_PROTOCOL_FINGERPRINT,
  selectCodexCompatibility,
  SUPPORTED_CODEX_VERSIONS,
  TESTED_CODEX_VERSION,
  validateCodexCompatibilityManifest,
} from "./compatibility";
export type {
  CodexCompatibilityManifest,
  CodexCompatibilityProfile,
  CodexCompatibilitySelection,
} from "./compatibility";
export type { CodexProtocolCodec } from "./protocol-codec";

export function codexVersion(value: string): string | undefined {
  return value.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.at(0);
}

export class CodexCallerAttestor implements RuntimeCallerAttestor {
  readonly harnessId = "codex";
  readonly scheme = "codex-mcp-thread-meta-v1";
  readonly schemes = [this.scheme];
  constructor(
    private installationId: RuntimeInstallationId,
    private compatibility: () => CodexCompatibilitySelection,
  ) {}
  async attest(evidence: HostInvocationEvidence): Promise<CallerAttestationResult> {
    if (evidence.harnessId !== this.harnessId)
      return { kind: "unattested", reason: "unsupported-harness" };
    const selected = this.compatibility();
    if (
      selected.state !== "tested" ||
      selected.profile.capabilities.callerAttestation?.supported !== true
    )
      return { kind: "unattested", reason: "unsupported-runtime-version" };
    if (!evidence.metadata) return { kind: "unattested", reason: "missing-host-metadata" };
    const threadId = decodeCallerThreadId(evidence.metadata);
    if (threadId === undefined) return { kind: "unattested", reason: "missing-session-id" };
    if (threadId === null) return { kind: "unattested", reason: "invalid-session-id" };
    return {
      kind: "attested",
      scheme: selected.profile.callerAttestation.decoderId,
      session: { installationId: this.installationId, opaqueId: threadId },
      evidenceFingerprint: createHash("sha256")
        .update(`${selected.profile.callerAttestation.decoderId}\0${this.harnessId}\0${threadId}`)
        .digest("base64url"),
      attributes: { compatibilityProfile: selected.profile.profileId },
    };
  }
}

const defaultProfile = defaultCompatibilityProfile();
const capabilities: RuntimeCapabilities = profileCapabilities(defaultProfile);
const disabledCapabilities = (): RuntimeCapabilities => ({
  ...capabilities,
  appendContext: false,
  wakeWhenIdle: false,
  cancelOwnedExecution: false,
  reconcileDelivery: false,
  callerAttestationSchemes: [],
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

function defaultCompatibilityProfile() {
  const profile = CODEX_COMPATIBILITY_PROFILES.at(0);
  if (!profile) throw new Error("Codex compatibility manifest has no profiles");
  return profile;
}
type SessionCursor = {
  phase: "stored" | "loaded";
  vendorCursor?: string;
  storedIds: string[];
};

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

  compatibility(): CodexCompatibilitySelection {
    return selectCodexCompatibility(this.runtimeVersion);
  }

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
  async probe(signal?: AbortSignal): Promise<RuntimeProbeResult> {
    this.assertRunning();
    signal?.throwIfAborted();
    try {
      if (!this.client) throw new Error("adapter not started");
      await this.client.listThreads({ limit: 1, useStateDbOnly: true }, signal);
      const selected = this.compatibility();
      if (selected.state !== "tested")
        return {
          state: "incompatible",
          observedAt: new Date().toISOString(),
          runtimeVersion: this.runtimeVersion,
          protocolFingerprint: CODEX_PROTOCOL_FINGERPRINT,
          capabilities: disabledCapabilities(),
          diagnostics: [
            {
              severity: "error",
              code:
                selected.state === "candidate-compatible"
                  ? "CODEX_VERSION_CANDIDATE"
                  : "CODEX_PROTOCOL_INCOMPATIBLE",
              message:
                selected.state === "candidate-compatible"
                  ? `Codex ${this.runtimeVersion ?? "unknown"} matches profile ${selected.profile.profileId}, but has no reviewed behavior evidence`
                  : `Unsupported Codex ${this.runtimeVersion ?? "unknown"} (${selected.reason})`,
              remediation:
                "Run the documented Codex profile evaluation workflow before enabling mutations.",
            },
          ],
        };
      return {
        state: "ready",
        observedAt: new Date().toISOString(),
        runtimeVersion: this.runtimeVersion,
        protocolFingerprint: CODEX_PROTOCOL_FINGERPRINT,
        capabilities: profileCapabilities(selected.profile),
        diagnostics: [
          {
            severity: "info",
            code: "CODEX_PROFILE_SELECTED",
            message: `Selected compatibility profile ${selected.profile.profileId}`,
          },
          {
            severity: "warning",
            code: "NON_ATOMIC_WAKE_ONLY",
            message:
              "Codex queue input cannot preserve named tool-output provenance; wake requires explicit non-atomic policy.",
          },
        ],
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = appServerFailure(error);
      return {
        state: "unavailable",
        observedAt: new Date().toISOString(),
        capabilities: disabledCapabilities(),
        diagnostics: [
          {
            severity: "error",
            code: "CODEX_UNAVAILABLE",
            message: `Codex app-server unavailable (${failure.kind})`,
          },
        ],
      };
    }
  }
  async listSessions(
    query: RuntimeSessionQuery,
    signal?: AbortSignal,
  ): Promise<RuntimeSessionPage> {
    this.assertRunning();
    signal?.throwIfAborted();
    const client = this.requireClient(),
      limit = Math.min(query.limit ?? 50, 100),
      cursor: SessionCursor = query.cursor
        ? sessionCursor(query.cursor)
        : { phase: "stored", storedIds: [] };
    let sessions: RuntimeSessionSnapshot[], nextCursor: string | undefined;
    if (cursor.phase === "stored") {
      const page = await client.listThreads(
          {
            cursor: cursor.vendorCursor,
            limit,
            searchTerm: query.text,
            sourceKinds: [],
            useStateDbOnly: false,
          },
          signal,
        ),
        storedIds = [...new Set([...cursor.storedIds, ...page.data.map((thread) => thread.id)])];
      sessions = filterSessions(
        page.data.map((thread) => this.snapshot(thread)),
        query,
      );
      nextCursor = sessionCursorString({
        phase: page.nextCursor ? "stored" : "loaded",
        vendorCursor: page.nextCursor ?? undefined,
        storedIds,
      });
      if (!page.data.length && !page.nextCursor) {
        const loadedPage = await client.loadedThreads(null, signal, limit);
        sessions = filterSessions(
          await this.loadedSessions(loadedPage.data, new Set(storedIds), signal),
          query,
        );
        nextCursor = loadedPage.nextCursor
          ? sessionCursorString({
              phase: "loaded",
              vendorCursor: loadedPage.nextCursor,
              storedIds,
            })
          : undefined;
      }
    } else {
      const loadedPage = await client.loadedThreads(cursor.vendorCursor ?? null, signal, limit);
      sessions = filterSessions(
        await this.loadedSessions(loadedPage.data, new Set(cursor.storedIds), signal),
        query,
      );
      nextCursor = loadedPage.nextCursor
        ? sessionCursorString({
            phase: "loaded",
            vendorCursor: loadedPage.nextCursor,
            storedIds: cursor.storedIds,
          })
        : undefined;
    }
    for (const state of availabilityStates)
      telemetry.gauge(
        "acs_runtime_sessions_by_state",
        sessions.filter((session) => session.availability === state).length,
        { state },
      );
    return { sessions, nextCursor };
  }
  private loadedSessions(ids: string[], storedIds: Set<string>, signal?: AbortSignal) {
    return Promise.all(
      ids
        .filter((id) => !storedIds.has(id))
        .map((opaqueId) =>
          this.inspectSession(
            { installationId: this.requireContext().installationId, opaqueId },
            signal,
          ),
        ),
    );
  }
  async inspectSession(
    session: RuntimeSessionRef,
    signal?: AbortSignal,
  ): Promise<RuntimeSessionSnapshot> {
    this.assertRunning();
    signal?.throwIfAborted();
    return telemetry.trace("runtime.inspect", async () => {
      try {
        return this.snapshot(
          (
            await this.requireClient().readThread(
              {
                threadId: session.opaqueId,
                includeTurns: false,
              },
              signal,
            )
          ).thread,
        );
      } catch (error: unknown) {
        if (sessionUnavailable(appServerFailure(error).kind))
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
  async deliver(
    request: RuntimeDeliveryRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeDeliveryResult> {
    this.assertRunning();
    signal?.throwIfAborted();
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
    if (request.mode === "wake_when_idle")
      for (const execution of this.executions.values())
        if (
          execution.session.installationId === request.target.session.installationId &&
          execution.session.opaqueId === request.target.session.opaqueId
        )
          return { outcome: "deferred", reason: "busy" };
    const snapshot = await this.inspectSession(request.target.session, signal);
    if (snapshot.availability === "offline") return { outcome: "deferred", reason: "offline" };
    const selected = this.compatibility();
    if (selected.state !== "tested")
      return { outcome: "rejected", reason: "runtime-protocol-error", retryable: false };
    const selectedCapabilities = profileCapabilities(selected.profile);
    if (
      (request.mode === "append_context" && !selectedCapabilities.appendContext) ||
      (request.mode === "wake_when_idle" && !selectedCapabilities.wakeWhenIdle)
    )
      return { outcome: "rejected", reason: "unsupported-mode", retryable: false };
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
            items: [
              jsonValue(
                JSON.stringify(
                  createCodexProtocolCodec(selected.profile).renderDeliveryEnvelope(
                    request.envelope,
                  ),
                ),
              ),
            ],
          },
          request.markRequestFlushed,
          signal,
        );
        return {
          outcome: "accepted",
          acceptedAt: new Date().toISOString(),
          evidence: { scheme: "codex.thread-inject-items.v1", value: request.deliveryId },
        };
      }
      await this.requireClient().resumeThread(request.target.session.opaqueId, signal);
      const execution = {
          deliveryId: request.deliveryId,
          payloadHash: request.payloadHash,
          session: request.target.session,
          finalParts: new Array<NeutralPart>(),
        },
        response = await this.requireClient().startTurn(
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
          signal,
          (turnId) => this.executions.set(turnId, execution),
        );
      return {
        outcome: "accepted",
        acceptedAt: new Date().toISOString(),
        execution: { opaqueId: response.turn.id, alreadyRunning: false },
        evidence: { scheme: "codex.turn-start.v1", value: response.turn.id },
      };
    } catch (error: unknown) {
      const failure = appServerFailure(error);
      if (signal?.aborted && failure.kind !== CodexAppServerFailureKind.RequestAbortedAfterWrite)
        throw error;
      if (failure.requestFlushed && deliveryAmbiguous(failure.kind))
        return {
          outcome: "acceptance-unknown",
          ambiguity: "connection-reset",
          reconciliationToken: `${request.target.session.opaqueId}:${request.deliveryId}`,
        };
      if (failure.kind === CodexAppServerFailureKind.Backpressure)
        return { outcome: "deferred", reason: "backpressure", retryAfterMs: 1000 };
      if (failure.kind === CodexAppServerFailureKind.SessionNotFound)
        return { outcome: "rejected", reason: "session-not-found", retryable: false };
      if (sessionUnavailable(failure.kind)) return { outcome: "deferred", reason: "offline" };
      if (failure.kind === CodexAppServerFailureKind.UnsupportedMethod)
        return { outcome: "rejected", reason: "unsupported-mode", retryable: false };
      return {
        outcome: "rejected",
        reason: "runtime-protocol-error",
        retryable: false,
        details: { code: failure.rpcCode ?? failure.kind },
      };
    }
  }
  async reconcile(
    request: RuntimeReconcileRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeReconcileResult> {
    this.assertRunning();
    signal?.throwIfAborted();
    const selected = this.compatibility();
    if (selected.state !== "tested" || !profileCapabilities(selected.profile).reconcileDelivery)
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
        signal,
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
      if (signal?.aborted) throw error;
      const failure = appServerFailure(error);
      return {
        outcome: "inconclusive",
        reason: `Codex reconciliation failed (${failure.kind})`,
        operatorActionRequired: true,
      };
    }
  }
  async cancel(request: RuntimeCancelRequest, signal?: AbortSignal): Promise<RuntimeCancelResult> {
    this.assertRunning();
    signal?.throwIfAborted();
    const selected = this.compatibility();
    if (selected.state !== "tested" || !profileCapabilities(selected.profile).cancelOwnedExecution)
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
        signal,
      );
      return { outcome: "accepted", acceptedAt: new Date().toISOString() };
    } catch (error: unknown) {
      const failure = appServerFailure(error);
      return failure.kind === CodexAppServerFailureKind.NotRunning ||
        failure.kind === CodexAppServerFailureKind.SessionNotFound
        ? { outcome: "not-running" }
        : { outcome: "unknown", reason: `Codex cancellation failed (${failure.kind})` };
    }
  }
  private snapshot(thread: CodexThreadDto): RuntimeSessionSnapshot {
    return {
      session: { installationId: this.requireContext().installationId, opaqueId: thread.id },
      availability: this.codec().normalizeStatus(thread.status),
      observedAt: new Date().toISOString(),
      revision: String(thread.updatedAt),
      attributes: {
        displayTitle: thread.name ?? thread.preview,
        cwdHint: thread.cwd,
        sourceKind: runtimeSourceKind(thread.source),
      },
    };
  }
  private supports(envelope: RuntimeDeliveryEnvelopeV1) {
    return (envelope.message?.parts ?? envelope.event?.parts ?? []).every(
      (part) => part.kind === "text" || part.kind === "uri" || part.kind === "data",
    );
  }
  private assertRunning() {
    if (this.stopped) throw new Error("runtime adapter stopped");
  }
  private requireClient() {
    if (!this.client || this.stopped)
      throw new CodexAppServerError("adapter not started", {
        kind: CodexAppServerFailureKind.ConnectionUnavailable,
        requestFlushed: false,
      });
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
          availability: this.codec().normalizeStatus(params.status),
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
  private codec() {
    const selected = this.compatibility();
    return createCodexProtocolCodec(
      selected.state === "incompatible" ? defaultProfile : selected.profile,
    );
  }
}

function decodeCallerThreadId(
  metadata: Readonly<Record<string, unknown>>,
): string | null | undefined {
  const threadId = metadata.threadId;
  if (threadId === undefined) return undefined;
  return typeof threadId === "string" && threadId.length > 0 && threadId.length <= 512
    ? threadId
    : null;
}

function filterSessions(sessions: RuntimeSessionSnapshot[], query: RuntimeSessionQuery) {
  const search = query.text?.toLocaleLowerCase();
  return sessions.filter(
    (session) =>
      (!query.availability?.length || query.availability.includes(session.availability)) &&
      (!search ||
        [
          session.session.opaqueId,
          session.attributes.displayTitle,
          session.attributes.cwdHint,
          session.attributes.sourceKind,
        ].some((value) => value?.toLocaleLowerCase().includes(search))),
  );
}
function sessionCursorString(cursor: SessionCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function sessionCursor(encoded: string): SessionCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    throw new Error("invalid runtime session cursor");
  }
  if (
    !isRecord(value) ||
    (value.phase !== "stored" && value.phase !== "loaded") ||
    (value.vendorCursor !== undefined && typeof value.vendorCursor !== "string") ||
    !Array.isArray(value.storedIds) ||
    value.storedIds.some((id) => typeof id !== "string")
  )
    throw new Error("invalid runtime session cursor");
  return {
    phase: value.phase,
    vendorCursor: value.vendorCursor,
    storedIds: value.storedIds,
  };
}
function runtimeSourceKind(source: unknown) {
  if (typeof source === "string") return source;
  if (
    typeof source === "object" &&
    source !== null &&
    "type" in source &&
    typeof source.type === "string"
  )
    return source.type;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function appServerFailure(error: unknown): CodexAppServerFailureDto {
  return error instanceof CodexAppServerError
    ? error.failure
    : { kind: CodexAppServerFailureKind.Unknown, requestFlushed: false };
}
function sessionUnavailable(kind: CodexAppServerFailureKind) {
  return (
    kind === CodexAppServerFailureKind.ConnectionLost ||
    kind === CodexAppServerFailureKind.ConnectionUnavailable ||
    kind === CodexAppServerFailureKind.NotInitialized ||
    kind === CodexAppServerFailureKind.SessionNotFound
  );
}
function deliveryAmbiguous(kind: CodexAppServerFailureKind) {
  return (
    kind === CodexAppServerFailureKind.ConnectionLost ||
    kind === CodexAppServerFailureKind.RequestAbortedAfterWrite ||
    kind === CodexAppServerFailureKind.RequestMarkerFailedAfterWrite ||
    kind === CodexAppServerFailureKind.RequestTimedOut
  );
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

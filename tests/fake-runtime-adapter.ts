import {
  RUNTIME_ADAPTER_API_VERSION,
  type RuntimeAdapter,
  type RuntimeAdapterContext,
  type RuntimeAdapterStopContext,
  type RuntimeCancelRequest,
  type RuntimeCancelResult,
  type RuntimeDeliveryRequest,
  type RuntimeDeliveryResult,
  type RuntimeEvent,
  type RuntimeProbeResult,
  type RuntimeReconcileRequest,
  type RuntimeReconcileResult,
  type RuntimeSessionPage,
  type RuntimeSessionQuery,
  type RuntimeSessionRef,
  type RuntimeSessionSnapshot,
} from "../contracts/runtime-adapter";

const capabilities = {
  listSessions: true,
  observeSessionState: true,
  observeExecutions: true,
  directDelivery: true,
  cancelOwnedExecution: true,
  reconcileDelivery: true,
  callerAttestationSchemes: [],
  supportedPartKinds: ["text", "uri", "data"],
} satisfies RuntimeAdapter["descriptor"]["capabilities"];

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor = {
    adapterApiVersion: RUNTIME_ADAPTER_API_VERSION,
    adapterId: "codex.app-server",
    harnessId: "codex",
    implementationVersion: "1",
    capabilities,
  } satisfies RuntimeAdapter["descriptor"];

  async start(_context: RuntimeAdapterContext) {}
  async stop(_context: RuntimeAdapterStopContext) {}
  async probe(): Promise<RuntimeProbeResult> {
    return {
      state: "ready",
      observedAt: new Date().toISOString(),
      capabilities,
      diagnostics: [],
    };
  }
  async listSessions(_query: RuntimeSessionQuery): Promise<RuntimeSessionPage> {
    return { sessions: [] };
  }
  async inspectSession(session: RuntimeSessionRef): Promise<RuntimeSessionSnapshot> {
    return {
      session,
      availability: "offline",
      observedAt: new Date().toISOString(),
      attributes: {},
    };
  }
  async *observe(signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield { type: "adapter.connection", state: "online" };
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  async deliver(
    _request: RuntimeDeliveryRequest,
    _signal?: AbortSignal,
  ): Promise<RuntimeDeliveryResult> {
    return { outcome: "rejected", reason: "runtime-protocol-error", retryable: false };
  }
  async reconcile(_request: RuntimeReconcileRequest): Promise<RuntimeReconcileResult> {
    return { outcome: "inconclusive", reason: "not configured", operatorActionRequired: true };
  }
  async cancel(_request: RuntimeCancelRequest): Promise<RuntimeCancelResult> {
    return { outcome: "unsupported" };
  }
}

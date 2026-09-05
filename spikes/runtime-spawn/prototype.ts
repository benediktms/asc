import type { AuthenticatedPrincipal } from "../../contracts/a2a-application-port";
import type { CodexThreadStartRequestDto } from "../../contracts/codex-app-server-boundary";
import type {
  RuntimeLifecycleAdapter,
  RuntimeLifecycleSnapshot,
  RuntimeSpawnRequest,
  RuntimeSpawnResult,
  RuntimeStopRequest,
  RuntimeStopResult,
} from "../../contracts/runtime-lifecycle";
import type { JsonObject, RuntimeInstallationId } from "../../contracts/runtime-adapter";
import type { AgentRow } from "../../packages/ports/src/index";
import { Store } from "../../packages/storage-sqlite/src/index";

/** Smallest app-server surface needed to prove the Codex mapping. */
export interface CodexThreadStarter {
  startThread(params: CodexThreadStartRequestDto): Promise<unknown>;
}

/**
 * Executable spike adapter. It proves the boundary and success path only; it
 * deliberately refuses stop/reconciliation claims that the spike did not prove.
 */
export class CodexThreadLifecyclePrototype implements RuntimeLifecycleAdapter {
  readonly lifecycleCapabilities = {
    spawn: true,
    stop: false,
    inspectBySession: false,
    inspectByRequestId: false,
  } as const;

  constructor(
    private client: CodexThreadStarter,
    private installationId: RuntimeInstallationId,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  async spawn(request: RuntimeSpawnRequest): Promise<RuntimeSpawnResult> {
    if (request.installationId !== this.installationId)
      return { outcome: "rejected", reason: "invalid-profile", retryable: false };
    if (request.workspace.kind !== "existing")
      return { outcome: "rejected", reason: "unsupported", retryable: false };
    const options = codexOptions(request.runtimeOptions),
      result = record(await this.client.startThread({ cwd: request.workspace.path, ...options })),
      thread = record(result.thread),
      threadId = stringField(thread, "id");
    return {
      outcome: "created",
      session: { installationId: this.installationId, opaqueId: threadId },
      observedAt: this.now(),
      evidence: { method: "thread/start", threadId },
    };
  }

  async stop(_request: RuntimeStopRequest): Promise<RuntimeStopResult> {
    return { outcome: "rejected", reason: "not proven by spike", retryable: false };
  }

  async inspectLifecycle(): Promise<RuntimeLifecycleSnapshot> {
    return { state: "unknown", observedAt: this.now(), attributes: {} };
  }
}

export interface SpawnedPrototypeAgent {
  readonly agent: AgentRow;
  readonly principal: AuthenticatedPrincipal;
  readonly sessionOpaqueId: string;
}

/**
 * Demonstrates the intended successful saga without claiming production
 * atomicity. Production must persist the request before either side effect.
 */
export async function spawnAndRegisterPrototype(
  store: Store,
  lifecycle: RuntimeLifecycleAdapter,
  request: RuntimeSpawnRequest,
  slug: string,
): Promise<SpawnedPrototypeAgent> {
  const agent = store.createAgent(slug),
    spawned = await lifecycle.spawn(request);
  if (spawned.outcome !== "created") throw new Error(`prototype spawn ${spawned.outcome}`);
  const binding = store.bind(agent.id, spawned.session.opaqueId, {
    installationId: spawned.session.installationId,
  });
  return {
    agent,
    sessionOpaqueId: spawned.session.opaqueId,
    principal: {
      id: binding.principalId,
      kind: "bound-agent",
      agentId: agent.id,
      bindingId: binding.id,
      scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
    },
  };
}

function codexOptions(options: JsonObject): CodexThreadStartRequestDto {
  const allowed = new Set(["approvalPolicy", "sandbox", "ephemeral"]);
  if (Object.keys(options).some((key) => !allowed.has(key)))
    throw new Error("unsupported Codex spawn option");
  const approvalPolicy = options.approvalPolicy,
    sandbox = options.sandbox,
    ephemeral = options.ephemeral;
  if (
    approvalPolicy !== undefined &&
    approvalPolicy !== "untrusted" &&
    approvalPolicy !== "on-request" &&
    approvalPolicy !== "never"
  )
    throw new Error("invalid Codex approval policy");
  if (
    sandbox !== undefined &&
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  )
    throw new Error("invalid Codex sandbox");
  if (ephemeral !== undefined && typeof ephemeral !== "boolean")
    throw new Error("invalid Codex ephemeral option");
  return { approvalPolicy, sandbox, ephemeral };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new Error(`invalid ${field}`);
  return result;
}

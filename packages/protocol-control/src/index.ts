import { readFileSync } from "node:fs";
import type {
  AgentRow,
  BindingRow,
  StoredArtifact,
  StoredPart,
  Store,
} from "../../storage-sqlite/src/index";
import type { RuntimeAdapter, RuntimeInstallationId } from "../../../contracts/runtime-adapter";
import type { ExecutorArtifact, ExecutorPart } from "../../../contracts/control-protocol";
import { TaskState } from "../../domain/src/index";

type Params = {
  agent: string;
  allowNonAtomicWake?: boolean;
  artifacts?: ExecutorArtifact[];
  bindingId: string;
  claimCode: string;
  choices?: string[];
  cursor?: string;
  deliveryId: string;
  description?: string;
  displayName?: string;
  enabled?: boolean;
  evidence?: { metadata?: { threadId?: unknown } };
  question?: string;
  reason?: string;
  resolution: string;
  retryable?: boolean;
  blocking?: boolean;
  session: string | { opaqueId: string };
  slug: string;
  summary?: string;
  parts?: ExecutorPart[];
  limit?: number;
  taskId: string;
  threadId?: unknown;
  ttlSeconds?: number;
  toBindingId?: string;
};
type Rpc = { jsonrpc: "2.0"; id: string | number; method: string; params?: Params };
const ok = (id: Rpc["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"] | null, error: unknown) =>
  Response.json(
    (() => {
      const message = error instanceof Error ? error.message : String(error),
        code = message.split(":")[0]!;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message,
          data: {
            code,
            retryable: ["RUNTIME_UNAVAILABLE", "OVERLOADED"].includes(code),
            correlationId: crypto.randomUUID(),
          },
        },
      };
    })(),
  );

export function controlHandler(
  store: Store,
  startedAt: string,
  shutdown: () => void,
  adapter?: RuntimeAdapter,
) {
  return async (request: Request) => {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("ACS-Control-Version") !== "1")
      return new Response("Unsupported control protocol version", { status: 426 });
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1],
      principal = token ? store.authenticate(token) : null;
    if (!principal) return new Response("Unauthorized", { status: 401 });
    let rpc: Rpc;
    try {
      rpc = (await request.json()) as Rpc;
    } catch (error) {
      return fail(null, error);
    }
    try {
      const p = rpc.params as Params;
      authorize(principal, rpc.method);
      const audit = (
        action: string,
        resourceType: string,
        resourceId?: string,
        details: Record<string, unknown> = {},
      ) =>
        store.audit(
          principal.id,
          action,
          resourceType,
          resourceId,
          {
            ...details,
          },
          String(rpc.id),
        );
      switch (rpc.method) {
        case "system.initialize":
          if (
            !String(
              (p as { protocolVersion?: string } | undefined)?.protocolVersion ?? "1.0",
            ).startsWith("1.")
          )
            throw new Error("VALIDATION_FAILED: incompatible protocol version");
          return ok(rpc.id, {
            protocolVersion: "1.0",
            server: { name: "acs", version: "0.1.0", instanceId: String(process.pid) },
            capabilities: {
              codex: Boolean(adapter),
              a2aJsonRpc: true,
              taskEventNotifications: true,
            },
          });
        case "system.health": {
          const probe = adapter ? await adapter.probe() : undefined;
          return ok(rpc.id, {
            status: probe?.state === "ready" ? "ok" : "degraded",
            database: "ok",
            adapters: [{ adapterId: "codex.app-server", status: probe?.state ?? "unavailable" }],
            startedAt,
          });
        }
        case "system.capabilities":
          return ok(rpc.id, {
            codex: adapter?.descriptor.capabilities ?? {
              callerAttestation: true,
              appendContext: false,
              wakeWhenIdle: false,
            },
            a2aJsonRpc: true,
          });
        case "system.shutdown":
          if (principal.kind !== "local-user") throw new Error("NOT_AUTHORIZED");
          audit("daemon.shutdown", "system");
          queueMicrotask(shutdown);
          return ok(rpc.id, { accepted: true });
        case "agents.create":
          admin(principal.kind);
          const createdAgent = store.createAgent(p.slug, p.displayName, p.description);
          audit("agent.create", "agent", createdAgent.id);
          return ok(rpc.id, { agent: agentDto(store, createdAgent) });
        case "agents.update":
          admin(principal.kind);
          const updatedAgent = store.updateAgent(p.agent, {
            displayName: p.displayName,
            description: p.description,
            enabled: p.enabled,
          });
          audit("agent.update", "agent", updatedAgent.id);
          return ok(rpc.id, { agent: agentDto(store, updatedAgent) });
        case "agents.delete":
          admin(principal.kind);
          const deletedAgent = store.agent(p.agent);
          if (!deletedAgent) throw new Error("AGENT_NOT_FOUND");
          store.deleteAgent(p.agent);
          audit("agent.delete", "agent", deletedAgent.id);
          return ok(rpc.id, { deleted: true });
        case "agents.createClaim":
          admin(principal.kind);
          const claim = store.createClaim(p.agent, principal.id, p.ttlSeconds);
          audit("binding.claim.create", "claim", claim.claimId);
          return ok(rpc.id, claim);
        case "agents.get": {
          const agent = store.agent(p.agent);
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          return ok(rpc.id, { agent: agentDto(store, agent) });
        }
        case "agents.list":
          const agentOffset = store.cursorOffset(p?.cursor);
          const agentLimit = Math.min(p?.limit ?? 50, 100),
            agents = store.agents().slice(agentOffset, agentOffset + agentLimit),
            lastAgent = agents.at(-1);
          return ok(rpc.id, {
            items: agents.map((agent) => agentDto(store, agent)),
            nextCursor:
              agents.length === agentLimit && lastAgent
                ? store.encodeCursor({
                    offset: agentOffset + agentLimit,
                    sortKey: lastAgent.slug,
                    id: lastAgent.id,
                  })
                : undefined,
          });
        case "bindings.bind":
          admin(principal.kind);
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          const sessionId = typeof p.session === "string" ? p.session : p.session.opaqueId;
          const bindInstallation = store.db
            .query("SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1")
            .get() as { id: string };
          if (
            (
              await adapter.inspectSession({
                installationId: bindInstallation.id as RuntimeInstallationId,
                opaqueId: sessionId,
              })
            ).availability === "offline"
          )
            throw new Error("RUNTIME_UNAVAILABLE: session not found");
          const createdBinding = store.bind(p.agent, sessionId, Boolean(p.allowNonAtomicWake));
          audit("binding.bind", "binding", createdBinding.id);
          return ok(rpc.id, { binding: bindingDto(createdBinding, store) });
        case "bindings.claim": {
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          const threadId = p.evidence?.metadata?.threadId;
          if (typeof threadId !== "string") throw new Error("UNATTESTED_CALLER");
          const claimInstallation = store.db
            .query("SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1")
            .get() as { id: string };
          if (
            (
              await adapter.inspectSession({
                installationId: claimInstallation.id as RuntimeInstallationId,
                opaqueId: threadId,
              })
            ).availability === "offline"
          )
            throw new Error("RUNTIME_UNAVAILABLE: session not found");
          const binding = store.claim(p.claimCode, threadId);
          audit("binding.claim", "binding", binding.id);
          const agent = store.agent(binding.agentId);
          return ok(rpc.id, {
            binding: bindingDto(binding, store),
            agent: agent ? agentDto(store, agent) : undefined,
          });
        }
        case "bindings.get": {
          const binding = store.binding(p.bindingId);
          if (!binding) throw new Error("BINDING_NOT_FOUND");
          return ok(rpc.id, { binding: bindingDto(binding, store) });
        }
        case "bindings.list":
          return ok(rpc.id, {
            items: (
              store.db
                .query("SELECT * FROM runtime_bindings ORDER BY created_at_ms DESC")
                .all() as BindingRow[]
            ).map((binding) => bindingDto(binding, store)),
            nextCursor: undefined,
          });
        case "bindings.revoke":
          admin(principal.kind);
          const revoked = store.revokeBinding(p.bindingId, p.reason)!;
          audit("binding.revoke", "binding", revoked.id, { reason: p.reason ?? "revoked" });
          return ok(rpc.id, { binding: bindingDto(revoked, store) });
        case "bindings.retargetPending": {
          admin(principal.kind);
          const agent = store.agent(p.agent);
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          const target = store.binding(p.toBindingId ?? p.bindingId);
          if (!target || target.agent_id !== agent.id || target.status !== "active")
            throw new Error("BINDING_NOT_FOUND");
          const changed = store.db
            .query(
              "UPDATE delivery_intents SET pinned_binding_id=?,pinned_binding_epoch=?,updated_at_ms=? WHERE target_agent_id=? AND state IN ('pending','deferred')",
            )
            .run(target.id, target.epoch, Date.now(), agent.id).changes;
          audit("binding.retarget-pending", "binding", target.id, { retargeted: changed });
          return ok(rpc.id, { retargeted: changed });
        }
        case "runtimes.list":
          return ok(rpc.id, {
            runtimes: store.db
              .query(
                "SELECT id installationId,harness_id harnessId,adapter_id adapterId,label FROM runtime_installations",
              )
              .all(),
          });
        case "runtimes.probe":
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          return ok(rpc.id, { probe: await adapter.probe() });
        case "runtimes.sessions.list":
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          return ok(rpc.id, await adapter.listSessions({ limit: 100 }));
        case "runtimes.sessions.inspect": {
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          const opaqueId = typeof p.session === "string" ? p.session : p.session.opaqueId;
          const inspectInstallation = store.db
            .query("SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1")
            .get() as { id: string };
          return ok(rpc.id, {
            session: await adapter.inspectSession({
              installationId: inspectInstallation.id as RuntimeInstallationId,
              opaqueId,
            }),
          });
        }
        case "bridge.attestCaller": {
          const a = store.attest(p.evidence?.metadata?.threadId);
          return ok(rpc.id, a);
        }
        case "bridge.identity": {
          const a = store.attest(p.evidence?.metadata?.threadId);
          return ok(rpc.id, {
            attestation: a,
            agent:
              a.kind === "attested" && store.agent(a.agentId)
                ? agentDto(store, store.agent(a.agentId)!)
                : undefined,
          });
        }
        case "bridge.issueA2AToken": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(rpc.id, { token: store.issueToken(a.principalId), principalId: a.principalId });
        }
        case "inbox.list": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(rpc.id, { items: store.inbox(a.agentId) });
        }
        case "inbox.get": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          const task = store.inboxTask(a.agentId, p.taskId);
          if (!task) throw new Error("TASK_NOT_FOUND");
          return ok(rpc.id, { task });
        }
        case "bridge.taskTarget": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          const row = store.db
            .query(
              "SELECT ag.slug FROM a2a_tasks t JOIN agents ag ON ag.id=t.target_agent_id WHERE t.id=? AND t.requester_principal_id=?",
            )
            .get(p.taskId, a.principalId) as { slug: string } | null;
          if (!row) throw new Error("TASK_NOT_FOUND");
          return ok(rpc.id, row);
        }
        case "executor.task.complete":
        case "executor.task.fail":
        case "executor.task.requestInput":
        case "executor.task.acknowledge": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          const state = rpc.method.endsWith("complete")
            ? TaskState.Completed
            : rpc.method.endsWith("fail")
              ? TaskState.Failed
              : rpc.method.endsWith("requestInput")
                ? TaskState.InputRequired
                : TaskState.Working;
          if (rpc.method.endsWith("complete") && p.artifacts?.length)
            store.publishArtifacts(p.taskId, a.principalId, p.artifacts.map(toArtifact));
          const details = rpc.method.endsWith("requestInput")
            ? { choices: p.choices ?? [], blocking: p.blocking ?? true }
            : rpc.method.endsWith("fail")
              ? { retryable: p.retryable ?? false }
              : {};
          return ok(rpc.id, {
            task: store.setTaskState(
              p.taskId,
              a.principalId,
              state,
              p.summary ?? p.question ?? "",
              details,
            ),
            eventSequence: store.eventSequence(p.taskId),
          });
        }
        case "executor.task.publishMessage": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(
            rpc.id,
            store.publishMessage(p.taskId, a.principalId, (p.parts ?? []).map(toPart), p.summary),
          );
        }
        case "executor.task.publishArtifact": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(
            rpc.id,
            store.publishArtifacts(p.taskId, a.principalId, (p.artifacts ?? []).map(toArtifact)),
          );
        }
        case "deliveries.list":
          return ok(rpc.id, {
            items: store.db
              .query("SELECT * FROM delivery_intents ORDER BY created_at_ms DESC LIMIT 100")
              .all(),
            nextCursor: undefined,
          });
        case "deliveries.get": {
          const item = store.db
            .query("SELECT * FROM delivery_intents WHERE id=?")
            .get(p.deliveryId);
          if (!item) throw new Error("DELIVERY_NOT_FOUND");
          return ok(rpc.id, { delivery: item });
        }
        case "deliveries.retry":
          admin(principal.kind);
          const retried = store.retryDelivery(p.deliveryId);
          audit("delivery.retry", "delivery", p.deliveryId);
          return ok(rpc.id, { delivery: retried });
        case "deliveries.cancel":
          admin(principal.kind);
          const canceled = store.cancelDelivery(p.deliveryId, p.reason);
          audit("delivery.cancel", "delivery", p.deliveryId);
          return ok(rpc.id, { delivery: canceled });
        case "deliveries.resolveUnknown":
          admin(principal.kind);
          const resolved = store.resolveUnknown(p.deliveryId, p.resolution);
          audit("delivery.resolve-unknown", "delivery", p.deliveryId, { resolution: p.resolution });
          return ok(rpc.id, { delivery: resolved });
        default:
          throw new Error("METHOD_NOT_FOUND");
      }
    } catch (error) {
      return fail(rpc.id, error);
    }
  };
}

export async function controlCall<T = unknown>(
  socketPath: string,
  tokenPath: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    token = readFileSync(tokenPath, "utf8");
  return await new Promise<T>((resolve, reject) => {
    let response = Buffer.alloc(0),
      expected = Infinity;
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(
            `POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nACS-Control-Version: 1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        },
        data(_socket, data) {
          response = Buffer.concat([response, Buffer.from(data)]);
          const split = response.indexOf("\r\n\r\n");
          if (split >= 0 && expected === Infinity) {
            const header = response.subarray(0, split).toString();
            expected = split + 4 + Number(header.match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
          }
          if (response.length >= expected) finish();
        },
        close() {
          if (response.length) finish();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      const split = response.indexOf("\r\n\r\n");
      try {
        const rpc = JSON.parse(response.subarray(split + 4).toString()) as {
          error?: { message: string };
          result: T;
        };
        if (rpc.error) reject(new Error(rpc.error.message));
        else resolve(rpc.result);
      } catch (error) {
        reject(error);
      }
    }
  });
}

function admin(kind: string) {
  if (kind !== "local-user") throw new Error("NOT_AUTHORIZED");
}
function authorize(principal: { kind: string; scopes: string[] }, method: string) {
  if (principal.scopes.includes("*")) return;
  const scope = method.startsWith("bridge.issueA2AToken")
    ? "bridge:token"
    : method.startsWith("bridge.") || method === "bindings.claim"
      ? "bridge:attest"
      : method.startsWith("executor.")
        ? "executor"
        : method.startsWith("inbox.")
          ? "inbox"
          : method === "agents.get" || method === "agents.list"
            ? "agents:read"
            : method.startsWith("system.")
              ? undefined
              : null;
  if (scope === null || (scope && !principal.scopes.includes(scope)))
    throw new Error("NOT_AUTHORIZED");
}
function agentDto(store: Store, agent: AgentRow) {
  const binding = store.db
    .query("SELECT * FROM runtime_bindings WHERE agent_id=? AND status='active'")
    .get(agent.id) as BindingRow | null;
  return {
    id: agent.id,
    slug: agent.slug,
    displayName: agent.display_name,
    description: agent.description,
    enabled: Boolean(agent.enabled),
    skills: JSON.parse(agent.skills_json) as unknown[],
    availability: binding?.last_observed_availability ?? "unknown",
    binding: binding
      ? { id: binding.id, harnessId: "codex", epoch: binding.epoch, status: binding.status }
      : undefined,
    createdAt: new Date(agent.created_at_ms).toISOString(),
    updatedAt: new Date(agent.updated_at_ms).toISOString(),
  };
}
function bindingDto(
  binding: BindingRow | { id: string; agentId: string; sessionId: string; epoch: number },
  store: Store,
) {
  const row = "agent_id" in binding ? binding : store.binding(binding.id)!;
  return {
    id: row.id,
    agentId: row.agent_id,
    installationId: row.installation_id,
    harnessId: "codex",
    session: { installationId: row.installation_id, opaqueId: row.session_opaque_id },
    epoch: row.epoch,
    status: row.status,
    continuityPolicy: row.continuity_policy,
    deliveryPolicy: JSON.parse(row.delivery_policy_json) as Record<string, unknown>,
    createdAt: new Date(row.created_at_ms).toISOString(),
    activatedAt: row.activated_at_ms ? new Date(row.activated_at_ms).toISOString() : undefined,
    revokedAt: row.revoked_at_ms ? new Date(row.revoked_at_ms).toISOString() : undefined,
  };
}
function toPart(part: ExecutorPart): StoredPart {
  if (part.kind === "text")
    return {
      content: { $case: "text", value: part.text },
      filename: "",
      mediaType: part.mediaType ?? "text/plain",
    };
  if (part.kind === "uri")
    return {
      content: { $case: "url", value: part.uri },
      filename: part.name ?? "",
      mediaType: part.mediaType ?? "application/octet-stream",
    };
  return {
    content: { $case: "data", value: part.data },
    filename: part.name ?? "",
    mediaType: part.mediaType,
  };
}
function toArtifact(artifact: ExecutorArtifact): StoredArtifact {
  const part: ExecutorPart =
    artifact.kind === "uri"
      ? { kind: "uri", uri: artifact.uri ?? "", name: artifact.name, mediaType: artifact.mediaType }
      : {
          kind: "data",
          data: artifact.data ?? null,
          name: artifact.name,
          mediaType: artifact.mediaType ?? "application/json",
        };
  return {
    artifactId: crypto.randomUUID(),
    name: artifact.name,
    description: artifact.description ?? "",
    parts: [toPart(part)],
    metadata: undefined,
    extensions: [],
  };
}

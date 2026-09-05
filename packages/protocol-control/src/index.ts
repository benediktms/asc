import { readFileSync } from "node:fs";
import type {
  AgentRow,
  BindingRow,
  DeliveryIntentRow,
  StoredArtifact,
  StoredPart,
  Store,
} from "../../storage-sqlite/src/index";
import type { RuntimeAdapter, RuntimeInstallationId } from "../../../contracts/runtime-adapter";
import type { ExecutorArtifact, ExecutorPart } from "../../../contracts/control-protocol";
import { TaskState } from "../../domain/src/index";
import { telemetry } from "../../observability/src/index";
import { z } from "zod";

const partSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string(), mediaType: z.string().optional() }),
    z.object({
      kind: z.literal("uri"),
      uri: z.string(),
      name: z.string().optional(),
      mediaType: z.string().optional(),
    }),
    z.object({
      kind: z.literal("data"),
      data: z.json(),
      name: z.string().optional(),
      mediaType: z.string(),
    }),
  ]),
  artifactSchema = z.object({
    kind: z.enum(["uri", "data"]),
    uri: z.string().optional(),
    data: z.json().optional(),
    name: z.string(),
    mediaType: z.string().optional(),
    description: z.string().optional(),
  }),
  paramsSchema = z.looseObject({
    agent: z.string().optional(),
    availability: z.array(z.string()).optional(),
    artifacts: z.array(artifactSchema).optional(),
    bindingId: z.string().optional(),
    claimCode: z.string().optional(),
    choices: z.array(z.string()).optional(),
    cursor: z.string().optional(),
    deliveryId: z.string().optional(),
    description: z.string().optional(),
    deliveryPolicy: z
      .object({
        wakeStrategy: z.enum(["atomic-only", "non-atomic-idle-check", "disabled"]).optional(),
        allowActiveTurnSteering: z.boolean().optional(),
        autoResumeDormantThread: z.boolean().optional(),
        interruptOnCancel: z.boolean().optional(),
      })
      .optional(),
    displayName: z.string().optional(),
    enabled: z.boolean().optional(),
    evidence: z
      .looseObject({ metadata: z.looseObject({ threadId: z.unknown() }).optional() })
      .optional(),
    installationId: z.string().optional(),
    question: z.string().optional(),
    reason: z.string().optional(),
    revokeExisting: z.boolean().optional(),
    state: z.array(z.string()).optional(),
    states: z.array(z.string()).optional(),
    status: z.array(z.string()).optional(),
    resolution: z
      .enum(["accepted", "not-accepted-and-retry", "not-accepted-and-cancel"])
      .optional(),
    retryable: z.boolean().optional(),
    blocking: z.boolean().optional(),
    session: z
      .union([
        z.string(),
        z.object({ installationId: z.string().optional(), opaqueId: z.string() }),
      ])
      .optional(),
    skill: z.string().optional(),
    slug: z.string().optional(),
    summary: z.string().optional(),
    continuityPolicy: z.enum(["follow-pending", "strict"]).optional(),
    targetAgent: z.string().optional(),
    text: z.string().optional(),
    parts: z.array(partSchema).optional(),
    protocolVersion: z.unknown(),
    limit: z.number().int().positive().optional(),
    taskId: z.string().optional(),
    threadId: z.unknown(),
    ttlSeconds: z.number().int().positive().optional(),
    toBindingId: z.string().optional(),
  });
type Params = z.infer<typeof paramsSchema>;
type Rpc = { jsonrpc: "2.0"; id: string | number; method: string; params: Params };
const ok = (id: Rpc["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"] | null, error: unknown) =>
  Response.json(
    (() => {
      const message = error instanceof Error ? error.message : String(error),
        code = message.split(":").at(0) ?? "UNKNOWN";
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
    telemetry.increment("acs_control_requests_total");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("ACS-Control-Version") !== "1")
      return new Response("Unsupported control protocol version", { status: 426 });
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1],
      principal = token ? store.authenticate(token) : null;
    if (!principal) {
      store.audit(null, "security.reject", "control", undefined, {
        reason: "unauthenticated",
      });
      return new Response("Unauthorized", { status: 401 });
    }
    let rpc: Rpc;
    try {
      const value: unknown = await request.json();
      rpc = parseRpc(value);
    } catch (error) {
      return fail(null, error);
    }
    try {
      const p = rpc.params;
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
          if (!String(p.protocolVersion ?? "1.0").startsWith("1."))
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
            metrics: store.metrics(),
            traces: telemetry.traceSnapshot(),
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
          const createdAgent = store.createAgent(
            required(p.slug, "slug"),
            p.displayName,
            p.description,
          );
          audit("agent.create", "agent", createdAgent.id);
          return ok(rpc.id, { agent: agentDto(store, createdAgent) });
        case "agents.update":
          admin(principal.kind);
          const updatedAgent = store.updateAgent(required(p.agent, "agent"), {
            displayName: p.displayName,
            description: p.description,
            enabled: p.enabled,
          });
          audit("agent.update", "agent", updatedAgent.id);
          return ok(rpc.id, { agent: agentDto(store, updatedAgent) });
        case "agents.delete":
          admin(principal.kind);
          const deletedAgentId = required(p.agent, "agent"),
            deletedAgent = store.agent(deletedAgentId);
          if (!deletedAgent) throw new Error("AGENT_NOT_FOUND");
          store.deleteAgent(deletedAgentId);
          audit("agent.delete", "agent", deletedAgent.id);
          return ok(rpc.id, { deleted: true });
        case "agents.createClaim":
          admin(principal.kind);
          const claim = store.createClaim(required(p.agent, "agent"), principal.id, p.ttlSeconds);
          audit("binding.claim.create", "claim", claim.claimId);
          return ok(rpc.id, claim);
        case "agents.get": {
          const agent = store.agent(required(p.agent, "agent"));
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          return ok(rpc.id, { agent: agentDto(store, agent) });
        }
        case "agents.list": {
          const agentLimit = Math.min(p.limit ?? 50, 100),
            text = p.text?.toLowerCase(),
            candidates = store
              .agents()
              .map((agent) => ({ agent, dto: agentDto(store, agent) }))
              .filter(
                ({ agent, dto }) =>
                  (p.enabled === undefined || Boolean(agent.enabled) === p.enabled) &&
                  (!p.availability?.length || p.availability.includes(dto.availability)) &&
                  (!p.skill || agentHasSkill(agent.skills_json, p.skill)) &&
                  (!text ||
                    [agent.slug, agent.display_name, agent.description].some((value) =>
                      value.toLowerCase().includes(text),
                    )),
              ),
            page = boundedLocalPage(
              store,
              candidates,
              agentLimit,
              p.cursor,
              ({ agent }) => ({ sortKey: agent.slug, id: agent.id }),
              "ascending",
            );
          return ok(rpc.id, {
            items: page.items.map(({ dto }) => dto),
            nextCursor: page.nextCursor,
          });
        }
        case "bindings.bind":
          admin(principal.kind);
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          const session = required(p.session, "session"),
            sessionId = typeof session === "string" ? session : session.opaqueId,
            requestedInstallation =
              p.installationId ??
              (typeof session === "string" ? undefined : session.installationId);
          const bindInstallation = required(
            store.db
              .query<{ id: RuntimeInstallationId }, []>(
                "SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1",
              )
              .get(),
            "runtime installation",
          );
          if (requestedInstallation && requestedInstallation !== bindInstallation.id)
            throw new Error("BINDING_CONFLICT: runtime installation mismatch");
          if (
            (
              await adapter.inspectSession({
                installationId: bindInstallation.id,
                opaqueId: sessionId,
              })
            ).availability === "offline"
          )
            throw new Error("RUNTIME_UNAVAILABLE: session not found");
          const createdBinding = store.bind(required(p.agent, "agent"), sessionId, {
            continuityPolicy: p.continuityPolicy,
            deliveryPolicy: p.deliveryPolicy,
            revokeExisting: p.revokeExisting,
          });
          audit("binding.bind", "binding", createdBinding.id);
          return ok(rpc.id, { binding: bindingDto(createdBinding, store) });
        case "bindings.claim": {
          if (!adapter) throw new Error("RUNTIME_UNAVAILABLE");
          const threadId = p.evidence?.metadata?.threadId;
          if (typeof threadId !== "string") throw new Error("UNATTESTED_CALLER");
          const claimInstallation = required(
            store.db
              .query<{ id: RuntimeInstallationId }, []>(
                "SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1",
              )
              .get(),
            "runtime installation",
          );
          if (
            (
              await adapter.inspectSession({
                installationId: claimInstallation.id,
                opaqueId: threadId,
              })
            ).availability === "offline"
          )
            throw new Error("RUNTIME_UNAVAILABLE: session not found");
          const binding = store.claim(required(p.claimCode, "claimCode"), threadId);
          audit("binding.claim", "binding", binding.id);
          const agent = store.agent(binding.agentId);
          return ok(rpc.id, {
            binding: bindingDto(binding, store),
            agent: agent ? agentDto(store, agent) : undefined,
          });
        }
        case "bindings.get": {
          const binding = store.binding(required(p.bindingId, "bindingId"));
          if (!binding) throw new Error("BINDING_NOT_FOUND");
          return ok(rpc.id, { binding: bindingDto(binding, store) });
        }
        case "bindings.list": {
          const agentFilter = p.agent ? store.agent(p.agent)?.id : undefined,
            page = boundedLocalPage(
              store,
              store.db
                .query<BindingRow, []>("SELECT * FROM runtime_bindings")
                .all()
                .filter(
                  (binding) =>
                    (!p.agent || binding.agent_id === agentFilter) &&
                    (!p.status?.length || p.status.includes(binding.status)),
                ),
              Math.min(p.limit ?? 50, 100),
              p.cursor,
              (binding) => ({
                sortKey: timestampKey(binding.created_at_ms),
                id: binding.id,
              }),
              "descending",
            );
          return ok(rpc.id, {
            items: page.items.map((binding) => bindingDto(binding, store)),
            nextCursor: page.nextCursor,
          });
        }
        case "bindings.revoke":
          admin(principal.kind);
          const revoked = required(
            store.revokeBinding(required(p.bindingId, "bindingId"), p.reason),
            "binding",
          );
          audit("binding.revoke", "binding", revoked.id, { reason: p.reason ?? "revoked" });
          return ok(rpc.id, { binding: bindingDto(revoked, store) });
        case "bindings.retargetPending": {
          admin(principal.kind);
          const agent = store.agent(required(p.agent, "agent"));
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          const target = store.binding(required(p.toBindingId ?? p.bindingId, "toBindingId"));
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
          const inspectSessionInput = required(p.session, "session"),
            opaqueId =
              typeof inspectSessionInput === "string"
                ? inspectSessionInput
                : inspectSessionInput.opaqueId;
          const inspectInstallation = required(
            store.db
              .query<{ id: RuntimeInstallationId }, []>(
                "SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1",
              )
              .get(),
            "runtime installation",
          );
          return ok(rpc.id, {
            session: await adapter.inspectSession({
              installationId: inspectInstallation.id,
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
          const agent = a.kind === "attested" ? store.agent(a.agentId) : undefined;
          return ok(rpc.id, {
            attestation: a,
            agent: agent ? agentDto(store, agent) : undefined,
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
          const states = p.states ?? ["submitted", "working", "input-required", "auth-required"],
            page = boundedLocalPage(
              store,
              store.inbox(a.agentId).filter((row) => states.includes(row.state)),
              Math.min(p.limit ?? 20, 100),
              p.cursor,
              (row) => ({ sortKey: timestampKey(row.updated_at_ms), id: row.id }),
              "descending",
            );
          return ok(rpc.id, {
            items: page.items.map((row) => row.task),
            nextCursor: page.nextCursor,
          });
        }
        case "inbox.get": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          const task = store.inboxTask(a.agentId, required(p.taskId, "taskId"));
          if (!task) throw new Error("TASK_NOT_FOUND");
          return ok(rpc.id, { task });
        }
        case "bridge.taskTarget": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          const row = store.db
            .query<{ slug: string }, [string, string]>(
              "SELECT ag.slug FROM a2a_tasks t JOIN agents ag ON ag.id=t.target_agent_id WHERE t.id=? AND t.requester_principal_id=?",
            )
            .get(required(p.taskId, "taskId"), a.principalId);
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
            store.publishArtifacts(
              required(p.taskId, "taskId"),
              a.principalId,
              p.artifacts.map(toArtifact),
            );
          const details = rpc.method.endsWith("requestInput")
            ? { choices: p.choices ?? [], blocking: p.blocking ?? true }
            : rpc.method.endsWith("fail")
              ? { retryable: p.retryable ?? false }
              : {};
          return ok(rpc.id, {
            task: store.setTaskState(
              required(p.taskId, "taskId"),
              a.principalId,
              state,
              p.summary ?? p.question ?? "",
              details,
            ),
            eventSequence: store.eventSequence(required(p.taskId, "taskId")),
          });
        }
        case "executor.task.publishMessage": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(
            rpc.id,
            store.publishMessage(
              required(p.taskId, "taskId"),
              a.principalId,
              (p.parts ?? []).map(toPart),
              p.summary,
            ),
          );
        }
        case "executor.task.publishArtifact": {
          const a = store.attest(p.threadId);
          if (a.kind !== "attested") throw new Error("UNATTESTED_CALLER");
          return ok(
            rpc.id,
            store.publishArtifacts(
              required(p.taskId, "taskId"),
              a.principalId,
              (p.artifacts ?? []).map(toArtifact),
            ),
          );
        }
        case "deliveries.list": {
          const targetAgent = p.targetAgent ? store.agent(p.targetAgent)?.id : undefined,
            page = boundedLocalPage(
              store,
              store.db
                .query<DeliveryIntentRow, []>("SELECT * FROM delivery_intents")
                .all()
                .filter(
                  (delivery) =>
                    (!p.state?.length || p.state.includes(delivery.state)) &&
                    (!p.targetAgent || delivery.target_agent_id === targetAgent) &&
                    (!p.taskId || delivery.task_id === p.taskId),
                ),
              Math.min(p.limit ?? 50, 100),
              p.cursor,
              (delivery) => ({
                sortKey: timestampKey(delivery.created_at_ms),
                id: delivery.id,
              }),
              "descending",
            );
          return ok(rpc.id, {
            items: page.items,
            nextCursor: page.nextCursor,
          });
        }
        case "deliveries.get": {
          const item = store.db
            .query("SELECT * FROM delivery_intents WHERE id=?")
            .get(required(p.deliveryId, "deliveryId"));
          if (!item) throw new Error("DELIVERY_NOT_FOUND");
          return ok(rpc.id, { delivery: item });
        }
        case "deliveries.retry":
          admin(principal.kind);
          const retryDeliveryId = required(p.deliveryId, "deliveryId"),
            retried = store.retryDelivery(retryDeliveryId);
          audit("delivery.retry", "delivery", retryDeliveryId);
          return ok(rpc.id, { delivery: retried });
        case "deliveries.cancel":
          admin(principal.kind);
          const cancelDeliveryId = required(p.deliveryId, "deliveryId"),
            canceled = store.cancelDelivery(cancelDeliveryId, p.reason);
          audit("delivery.cancel", "delivery", cancelDeliveryId);
          return ok(rpc.id, { delivery: canceled });
        case "deliveries.resolveUnknown":
          admin(principal.kind);
          const resolveDeliveryId = required(p.deliveryId, "deliveryId"),
            resolution = required(p.resolution, "resolution"),
            resolved = store.resolveUnknown(resolveDeliveryId, resolution);
          audit("delivery.resolve-unknown", "delivery", resolveDeliveryId, { resolution });
          return ok(rpc.id, { delivery: resolved });
        default:
          throw new Error("METHOD_NOT_FOUND");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "NOT_AUTHORIZED")
        store.audit(
          principal.id,
          "security.reject",
          "control",
          undefined,
          { reason: "not-authorized", method: rpc.method },
          String(rpc.id),
        );
      return fail(rpc.id, error);
    }
  };
}

export async function controlCall(
  socketPath: string,
  tokenPath: string,
  method: string,
  params: unknown = {},
): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    token = readFileSync(tokenPath, "utf8");
  return await new Promise<unknown>((resolve, reject) => {
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
        const rpc: unknown = JSON.parse(response.subarray(split + 4).toString());
        if (!isRecord(rpc)) throw new Error("Invalid control response");
        if (isRecord(rpc.error) && typeof rpc.error.message === "string")
          reject(new Error(rpc.error.message));
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
function boundedLocalPage<T>(
  store: Store,
  items: T[],
  limit: number,
  encodedCursor: string | undefined,
  key: (item: T) => { sortKey: string; id: string },
  direction: "ascending" | "descending",
) {
  const cursor = encodedCursor ? listCursor(store.decodeCursor(encodedCursor)) : undefined,
    compare = (left: T, right: T) => comparePageKeys(key(left), key(right), direction),
    ordered = items.toSorted(compare),
    remaining = cursor
      ? ordered.filter((item) => comparePageKeys(key(item), cursor, direction) > 0)
      : ordered,
    page = remaining.slice(0, limit),
    last = page.at(-1);
  return {
    items: page,
    nextCursor: remaining.length > limit && last ? store.encodeCursor(key(last)) : undefined,
  };
}
function listCursor(value: unknown) {
  if (!isRecord(value) || typeof value.sortKey !== "string" || typeof value.id !== "string")
    throw new Error("VALIDATION_FAILED: invalid cursor");
  return { sortKey: value.sortKey, id: value.id };
}
function comparePageKeys(
  left: { sortKey: string; id: string },
  right: { sortKey: string; id: string },
  direction: "ascending" | "descending",
) {
  const order = left.sortKey.localeCompare(right.sortKey) || left.id.localeCompare(right.id);
  return direction === "ascending" ? order : -order;
}
function timestampKey(value: number) {
  return String(value).padStart(16, "0");
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
    .query<BindingRow, [`agt_${string}`]>(
      "SELECT * FROM runtime_bindings WHERE agent_id=? AND status='active'",
    )
    .get(agent.id);
  return {
    id: agent.id,
    slug: agent.slug,
    displayName: agent.display_name,
    description: agent.description,
    enabled: Boolean(agent.enabled),
    skills: jsonArray(agent.skills_json),
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
  const row = "agent_id" in binding ? binding : required(store.binding(binding.id), "binding");
  return {
    id: row.id,
    agentId: row.agent_id,
    installationId: row.installation_id,
    harnessId: "codex",
    session: { installationId: row.installation_id, opaqueId: row.session_opaque_id },
    epoch: row.epoch,
    status: row.status,
    continuityPolicy: row.continuity_policy,
    deliveryPolicy: jsonRecord(row.delivery_policy_json),
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

function parseRpc(value: unknown): Rpc {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    (typeof value.id !== "string" && typeof value.id !== "number") ||
    typeof value.method !== "string" ||
    (value.params !== undefined && !isRecord(value.params))
  )
    throw new Error("VALIDATION_FAILED: invalid JSON-RPC request");
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
    params: paramsSchema.parse(value.params ?? {}),
  };
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`VALIDATION_FAILED: missing ${name}`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonArray(json: string) {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("STORAGE_CORRUPT: expected array");
  return value;
}
function agentHasSkill(json: string, skill: string) {
  return jsonArray(json).some(
    (item) =>
      isRecord(item) &&
      (item.id === skill ||
        item.name === skill ||
        (Array.isArray(item.tags) && item.tags.includes(skill))),
  );
}
function jsonRecord(json: string) {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("STORAGE_CORRUPT: expected object");
  return value;
}

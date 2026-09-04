import { readFileSync } from "node:fs";
import type { Store } from "../../storage-sqlite/src/index";
import type { RuntimeAdapter, RuntimeInstallationId } from "../../../contracts/runtime-adapter";

type Params = {
  agent: string;
  allowNonAtomicWake?: boolean;
  bindingId: string;
  claimCode: string;
  deliveryId: string;
  description?: string;
  displayName?: string;
  enabled?: boolean;
  evidence?: { metadata?: { threadId?: unknown } };
  question?: string;
  reason?: string;
  resolution: string;
  session: string | { opaqueId: string };
  slug: string;
  summary?: string;
  taskId: string;
  threadId?: unknown;
  ttlSeconds?: number;
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
          queueMicrotask(shutdown);
          return ok(rpc.id, { accepted: true });
        case "agents.create":
          admin(principal.kind);
          return ok(rpc.id, { agent: store.createAgent(p.slug, p.displayName, p.description) });
        case "agents.update":
          admin(principal.kind);
          return ok(rpc.id, {
            agent: store.updateAgent(p.agent, {
              displayName: p.displayName,
              description: p.description,
              enabled: p.enabled,
            }),
          });
        case "agents.delete":
          admin(principal.kind);
          store.deleteAgent(p.agent);
          return ok(rpc.id, { deleted: true });
        case "agents.createClaim":
          admin(principal.kind);
          return ok(rpc.id, store.createClaim(p.agent, principal.id, p.ttlSeconds));
        case "agents.get": {
          const agent = store.agent(p.agent);
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          return ok(rpc.id, { agent });
        }
        case "agents.list":
          return ok(rpc.id, { items: store.agents(), nextCursor: undefined });
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
          return ok(rpc.id, {
            binding: store.bind(p.agent, sessionId, Boolean(p.allowNonAtomicWake)),
          });
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
          return ok(rpc.id, { binding, agent: store.agent(binding.agentId) });
        }
        case "bindings.get": {
          const binding = store.binding(p.bindingId);
          if (!binding) throw new Error("BINDING_NOT_FOUND");
          return ok(rpc.id, { binding });
        }
        case "bindings.list":
          return ok(rpc.id, {
            items: store.db
              .query("SELECT * FROM runtime_bindings ORDER BY created_at_ms DESC")
              .all(),
            nextCursor: undefined,
          });
        case "bindings.revoke":
          admin(principal.kind);
          return ok(rpc.id, { binding: store.revokeBinding(p.bindingId, p.reason) });
        case "bindings.retargetPending": {
          admin(principal.kind);
          const agent = store.agent(p.agent);
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          const target = store.binding(p.bindingId);
          if (!target || target.agent_id !== agent.id || target.status !== "active")
            throw new Error("BINDING_NOT_FOUND");
          const changed = store.db
            .query(
              "UPDATE delivery_intents SET pinned_binding_id=?,pinned_binding_epoch=?,updated_at_ms=? WHERE target_agent_id=? AND state IN ('pending','deferred')",
            )
            .run(target.id, target.epoch, Date.now(), agent.id).changes;
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
            agent: a.kind === "attested" ? store.agent(a.agentId) : undefined,
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
            ? "completed"
            : rpc.method.endsWith("fail")
              ? "failed"
              : rpc.method.endsWith("requestInput")
                ? "input-required"
                : "working";
          return ok(rpc.id, {
            task: store.setTaskState(p.taskId, a.principalId, state, p.summary ?? p.question ?? ""),
            eventSequence: 0,
          });
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
          return ok(rpc.id, { delivery: store.retryDelivery(p.deliveryId) });
        case "deliveries.cancel":
          admin(principal.kind);
          return ok(rpc.id, { delivery: store.cancelDelivery(p.deliveryId, p.reason) });
        case "deliveries.resolveUnknown":
          admin(principal.kind);
          return ok(rpc.id, { delivery: store.resolveUnknown(p.deliveryId, p.resolution) });
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

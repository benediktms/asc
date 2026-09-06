import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, Role, TaskState as A2ATaskState } from "@a2a-js/sdk";
import { controlHandler } from "../packages/protocol-control/src/index";
import { CodexCallerAttestor } from "../packages/runtime-codex/src/index";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import { FakeRuntimeAdapter } from "./fake-runtime-adapter";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("control protocol", () => {
  test("requires protocol version and verifies a runtime session before binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-control-"));
    roots.push(root);
    const paths: Paths = {
      data: join(root, "acs.db"),
      runtime: join(root, "control.sock"),
      token: join(root, "control.token"),
      bridgeToken: join(root, "bridge.token"),
      secret: join(root, "secret.key"),
    };
    const store = new Store(paths),
      inspected: string[] = [],
      adapter = new FakeRuntimeAdapter();
    let sessionQuery: unknown;
    adapter.listSessions = async (query) => {
      sessionQuery = query;
      return { sessions: [], nextCursor: "next" };
    };
    adapter.inspectSession = async (session) => {
      inspected.push(session.opaqueId);
      return {
        session,
        availability: "idle",
        observedAt: new Date().toISOString(),
        attributes: {},
      };
    };
    const installation = required(
        store.db
          .query<{ id: `ins_${string}` }, []>("SELECT id FROM runtime_installations LIMIT 1")
          .get(),
        "installation",
      ),
      handler = controlHandler(
        store,
        new Date().toISOString(),
        () => {},
        adapter,
        new CodexCallerAttestor(installation.id),
      ),
      token = readFileSync(paths.token, "utf8");
    expect(
      (
        await handler(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "ACS-Control-Version": "1",
              "content-type": "text/plain",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
    const call = async (method: string, params: unknown, version = "1", bearer = token) =>
      handler(
        new Request("http://localhost", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "ACS-Control-Version": version,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: "test", method, params }),
        }),
      );
    expect(await (await call("system.initialize", {})).json()).toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
    expect(await (await call("agents.list", { limit: "many" })).json()).toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
    expect(
      await (
        await call("system.initialize", {
          protocolVersion: "1.0",
          client: { name: "test", version: "1", instanceId: "test" },
          capabilities: {},
        })
      ).json(),
    ).toMatchObject({ result: { protocolVersion: "1.0" } });
    for (const protocolVersion of ["1", "1.x", "2.0"])
      expect(
        await (
          await call("system.initialize", {
            protocolVersion,
            client: { name: "test", version: "1", instanceId: "test" },
            capabilities: {},
          })
        ).json(),
      ).toMatchObject({ error: { data: { code: "VALIDATION_FAILED" } } });
    expect(
      await (
        await call("system.initialize", {
          protocolVersion: "1.7",
          client: { name: "test", version: "1", instanceId: "test" },
          capabilities: {},
        })
      ).json(),
    ).toMatchObject({ result: { protocolVersion: "1.0" } });
    const unavailableCapabilities = await controlHandler(store, new Date().toISOString(), () => {})(
      new Request("http://localhost", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "ACS-Control-Version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "capabilities",
          method: "system.capabilities",
          params: {},
        }),
      }),
    );
    expect(await unavailableCapabilities.json()).toMatchObject({
      result: {
        codex: {
          listSessions: false,
          appendContext: false,
          callerAttestationSchemes: [],
          supportedPartKinds: [],
        },
      },
    });
    expect(
      await (
        await call("agents.create", {
          slug: "backend",
          skills: [{ id: "coding", name: "Coding", description: "Writes code" }],
        })
      ).json(),
    ).toMatchObject({ result: { agent: { skills: [{ id: "coding" }] } } });
    expect(
      await (
        await call("bindings.bind", {
          agent: "backend",
          installationId: installation.id,
          session: { installationId: installation.id, opaqueId: "thread-1" },
          continuityPolicy: "strict",
          deliveryPolicy: { wakeStrategy: "disabled", interruptOnCancel: false },
        })
      ).json(),
    ).toMatchObject({
      result: {
        binding: {
          continuityPolicy: "strict",
          deliveryPolicy: { wakeStrategy: "disabled", interruptOnCancel: false },
        },
      },
    });
    expect(await (await call("agents.get", { agent: "backend" })).json()).toMatchObject({
      result: { agent: { availability: "idle" } },
    });
    const backendBinding = required(
        store.db
          .query<{ id: string; epoch: number }, []>(
            "SELECT id,epoch FROM runtime_bindings WHERE status='active'",
          )
          .get(),
        "binding",
      ),
      callerEvidence = evidence("thread-1");
    await call("agents.create", { slug: "claimed" });
    const claim = record(
        record(await (await call("agents.createClaim", { agent: "claimed" })).json()).result,
      ),
      claimed = record(
        await (
          await call("bindings.claim", {
            claimCode: claim.claimCode,
            continuityPolicy: "strict",
            deliveryPolicy: { wakeStrategy: "disabled" },
            evidence: evidence("claimed-thread"),
          })
        ).json(),
      );
    expect(claimed).toMatchObject({
      result: {
        agent: { slug: "claimed" },
        idempotent: false,
        binding: {
          installationId: installation.id,
          session: { opaqueId: "claimed-thread" },
          continuityPolicy: "strict",
          deliveryPolicy: { wakeStrategy: "disabled" },
        },
      },
    });
    const claimedResult = record(claimed.result),
      claimedBinding = record(claimedResult.binding);
    expect(
      await (
        await call("bindings.claim", {
          claimCode: claim.claimCode,
          evidence: evidence("claimed-thread"),
        })
      ).json(),
    ).toMatchObject({
      result: { idempotent: true, binding: { id: claimedBinding.id, epoch: 1 } },
    });
    expect(
      await (
        await call("bindings.claim", {
          claimCode: claim.claimCode,
          evidence: evidence("claim-thief"),
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "CLAIM_CONSUMED" } } });
    expect(
      await (
        await call("bindings.claim", {
          claimCode: claim.claimCode,
          evidence: evidence("claimed-thread", "other"),
        })
      ).json(),
    ).toMatchObject({
      error: {
        message: expect.stringContaining("unsupported-harness"),
        data: { code: "UNATTESTED_CALLER" },
      },
    });
    expect(
      await (
        await call("bindings.claim", {
          claimCode: claim.claimCode,
          evidence: {
            harnessId: "codex",
            bridge: "mcp",
            metadata: { threadId: ["ambiguous-one", "ambiguous-two"] },
            bridgeInstanceId: "test-bridge",
          },
        })
      ).json(),
    ).toMatchObject({
      error: {
        message: expect.stringContaining("invalid-session-id"),
        data: { code: "UNATTESTED_CALLER" },
      },
    });
    expect(
      await (await call("bridge.identity", { evidence: evidence("claimed-thread") })).json(),
    ).toMatchObject({ result: { agent: { slug: "claimed" }, attestation: { kind: "attested" } } });

    await call("agents.create", { slug: "expired" });
    const expiredClaim = record(
      record(await (await call("agents.createClaim", { agent: "expired" })).json()).result,
    );
    if (typeof expiredClaim.claimId !== "string") throw new Error("missing expired claim ID");
    store.db
      .query("UPDATE binding_claims SET created_at_ms=?,expires_at_ms=? WHERE id=?")
      .run(Date.now() - 2_000, Date.now() - 1_000, expiredClaim.claimId);
    expect(
      await (
        await call("bindings.claim", {
          claimCode: expiredClaim.claimCode,
          evidence: evidence("expired-thread"),
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "CLAIM_EXPIRED" } } });
    expect(
      await (
        await call("bindings.claim", {
          claimCode: "RAW-CLAIM-SECRET",
          evidence: evidence("invalid-thread"),
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "CLAIM_INVALID" } } });
    const rejectedAudit = store.db
        .query<{ details_json: string }, []>(
          "SELECT details_json FROM audit_events WHERE action='binding.claim.reject' AND details_json LIKE '%CLAIM_INVALID%' LIMIT 1",
        )
        .get(),
      claimAudit = store.db
        .query<{ details: string }, []>(
          "SELECT group_concat(details_json) details FROM audit_events WHERE action LIKE 'binding.claim.%'",
        )
        .get();
    expect(rejectedAudit?.details_json).toContain("CLAIM_INVALID");
    expect(claimAudit?.details).not.toContain("RAW-CLAIM-SECRET");

    const rebindClaim = record(
      record(await (await call("agents.createClaim", { agent: "claimed" })).json()).result,
    );
    expect(
      await (
        await call("bindings.claim", {
          claimCode: rebindClaim.claimCode,
          evidence: evidence("new-claimed-thread"),
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "BINDING_CONFLICT" } } });
    const reboundClaim = record(
      await (
        await call("bindings.claim", {
          claimCode: rebindClaim.claimCode,
          revokeExisting: true,
          evidence: evidence("new-claimed-thread"),
        })
      ).json(),
    );
    expect(reboundClaim).toMatchObject({
      result: {
        idempotent: false,
        binding: { epoch: 2, session: { opaqueId: "new-claimed-thread" } },
      },
    });
    expect(
      await (await call("bridge.identity", { evidence: evidence("claimed-thread") })).json(),
    ).toMatchObject({ result: { attestation: { kind: "unattested", reason: "unbound-session" } } });
    expect(
      store.db
        .query<{ count: number }, []>(
          "SELECT count(*) count FROM audit_events WHERE action IN ('binding.claim.consume','binding.claim.reject','binding.rebind')",
        )
        .get()?.count,
    ).toBeGreaterThanOrEqual(6);
    expect(
      await (await call("bridge.attestCaller", { evidence: callerEvidence })).json(),
    ).toMatchObject({
      result: {
        kind: "attested",
        bindingId: backendBinding.id,
        bindingEpoch: backendBinding.epoch,
        session: { installationId: installation.id, opaqueId: "thread-1" },
        evidenceFingerprint: expect.any(String),
      },
    });
    expect(
      await (
        await call("bridge.attestCaller", {
          evidence: evidence("thread-1", "other"),
        })
      ).json(),
    ).toMatchObject({ result: { kind: "unattested", reason: "unsupported-harness" } });
    expect(
      await (await call("bridge.attestCaller", { evidence: evidence() })).json(),
    ).toMatchObject({ result: { kind: "unattested", reason: "missing-host-metadata" } });
    const inspectSession = adapter.inspectSession;
    adapter.inspectSession = async (session) => ({
      session,
      availability: "offline",
      observedAt: new Date().toISOString(),
      attributes: {},
    });
    expect(
      await (await call("bridge.attestCaller", { evidence: callerEvidence })).json(),
    ).toMatchObject({ result: { kind: "attested", bindingId: backendBinding.id } });
    store.db
      .query("UPDATE runtime_bindings SET last_observed_at_ms=? WHERE id=?")
      .run(Date.now() - 30_001, backendBinding.id);
    expect(
      await (await call("bridge.attestCaller", { evidence: callerEvidence })).json(),
    ).toMatchObject({ result: { kind: "unattested", reason: "runtime-unreachable" } });
    adapter.inspectSession = inspectSession;
    const bridgeToken = readFileSync(paths.bridgeToken, "utf8"),
      issued = record(
        record(
          await (
            await call(
              "bridge.issueA2AToken",
              {
                evidence: callerEvidence,
                bindingId: backendBinding.id,
                bindingEpoch: backendBinding.epoch,
                scopes: ["a2a:read"],
                ttlSeconds: 30,
              },
              "1",
              bridgeToken,
            )
          ).json(),
        ).result,
      ),
      issuedToken = issued.token;
    if (typeof issuedToken !== "string") throw new Error("expected issued token");
    expect(issued.expiresAt).toEqual(expect.any(String));
    expect(store.authenticate(issuedToken)?.scopes).toEqual(["a2a:read"]);
    expect(
      await (
        await call(
          "bridge.issueA2AToken",
          {
            evidence: callerEvidence,
            bindingId: backendBinding.id,
            bindingEpoch: backendBinding.epoch + 1,
            scopes: ["a2a:read"],
          },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ error: { data: { code: "STALE_BINDING" } } });
    const principal = required(store.authenticate(token), "principal"),
      assigned = store.accept(
        required(store.agent("backend"), "backend").id,
        principal.id,
        Message.fromJSON({
          messageId: "control-task-dto",
          role: Role.ROLE_USER,
          parts: [{ text: "work" }],
        }),
        {},
      );
    expect(
      await (
        await call(
          "bridge.taskTarget",
          { evidence: callerEvidence, taskId: assigned.task.id },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ result: { slug: "backend" } });
    expect(
      store.task(
        assigned.task.id,
        required(store.authenticate(issuedToken), "issued principal").id,
        required(store.agent("backend"), "backend").id,
      )?.id,
    ).toBe(assigned.task.id);
    expect(
      await (
        await call(
          "executor.task.acknowledge",
          { evidence: callerEvidence, taskId: assigned.task.id, deliveryId: assigned.deliveryId },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ result: { task: { id: assigned.task.id, state: "working" } } });
    expect(
      store.db
        .query<{ state: string; state_reason: string }, [string]>(
          "SELECT state,state_reason FROM delivery_intents WHERE id=?",
        )
        .get(assigned.deliveryId),
    ).toEqual({ state: "canceled", state_reason: "inbox-acknowledged" });
    expect(
      await (
        await call(
          "executor.task.complete",
          { evidence: callerEvidence, taskId: assigned.task.id },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ error: { data: { code: "VALIDATION_FAILED" } } });
    const completedRpc = record(
      await (
        await call(
          "executor.task.complete",
          { evidence: callerEvidence, taskId: assigned.task.id, summary: "done" },
          "1",
          bridgeToken,
        )
      ).json(),
    );
    if (!completedRpc.result) throw new Error(JSON.stringify(completedRpc));
    const completed = record(completedRpc.result);
    expect(completed.task).toMatchObject({
      id: assigned.task.id,
      contextId: assigned.task.contextId,
      state: "completed",
      stateVersion: 3,
      summary: "done",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(record(completed.task).status).toBeUndefined();
    const firstMessage = store.accept(
        required(store.agent("backend"), "backend").id,
        principal.id,
        Message.fromJSON({
          messageId: "observed-before-followup",
          role: Role.ROLE_USER,
          parts: [{ text: "first" }],
        }),
        {},
      ),
      followup = store.accept(
        required(store.agent("backend"), "backend").id,
        principal.id,
        Message.fromJSON({
          messageId: "unobserved-followup",
          taskId: firstMessage.task.id,
          contextId: firstMessage.task.contextId,
          role: Role.ROLE_USER,
          parts: [{ text: "second" }],
        }),
        {},
      ),
      backendPrincipal = required(store.authenticate(issuedToken), "backend principal").id;
    store.acknowledgeTask(firstMessage.task.id, backendPrincipal, firstMessage.deliveryId);
    expect(
      store.db
        .query<{ id: string; state: string }, [string]>(
          "SELECT id,state FROM delivery_intents WHERE task_id=? ORDER BY rowid",
        )
        .all(firstMessage.task.id),
    ).toEqual([
      { id: firstMessage.deliveryId, state: "canceled" },
      { id: followup.deliveryId, state: "pending" },
    ]);
    expect(() =>
      store.completeTask(firstMessage.task.id, backendPrincipal, "premature", []),
    ).toThrow("UNACKNOWLEDGED_MESSAGES");
    store.acknowledgeTask(firstMessage.task.id, backendPrincipal, followup.deliveryId);
    expect(
      store.completeTask(firstMessage.task.id, backendPrincipal, "both handled", []).status?.state,
    ).toBe(A2ATaskState.TASK_STATE_COMPLETED);
    const atomic = store.accept(
      required(store.agent("backend"), "backend").id,
      principal.id,
      Message.fromJSON({
        messageId: "atomic-completion",
        role: Role.ROLE_USER,
        parts: [{ text: "work" }],
      }),
      {},
    );
    await call(
      "executor.task.acknowledge",
      { evidence: callerEvidence, taskId: atomic.task.id, deliveryId: atomic.deliveryId },
      "1",
      bridgeToken,
    );
    store.db.exec(
      "CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON task_events WHEN NEW.event_type='task-completed' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END",
    );
    expect(
      await (
        await call(
          "executor.task.complete",
          {
            evidence: callerEvidence,
            taskId: atomic.task.id,
            summary: "not committed",
            artifacts: [{ kind: "uri", uri: "git:commit:missing", name: "missing" }],
          },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ error: { message: "injected completion failure" } });
    const afterFailedCompletion = store.task(atomic.task.id, principal.id);
    expect(afterFailedCompletion?.status?.state).toBe(A2ATaskState.TASK_STATE_WORKING);
    expect(afterFailedCompletion?.artifacts).toEqual([]);
    store.db.exec("DROP TRIGGER fail_completion");
    const completeAtomic = () =>
      call(
        "executor.task.complete",
        {
          evidence: callerEvidence,
          taskId: atomic.task.id,
          summary: "committed",
          artifacts: [{ kind: "uri", uri: "git:commit:present", name: "present" }],
        },
        "1",
        bridgeToken,
      );
    expect(await (await completeAtomic()).json()).toMatchObject({
      result: { task: { state: "completed", summary: "committed" } },
    });
    const terminalEventCount = store.eventsAfter(atomic.task.id, 0).length;
    expect(await (await completeAtomic()).json()).toMatchObject({
      result: { task: { state: "completed", summary: "committed" } },
    });
    expect(store.eventsAfter(atomic.task.id, 0)).toHaveLength(terminalEventCount);
    expect(
      await (
        await call(
          "executor.task.complete",
          {
            evidence: callerEvidence,
            taskId: atomic.task.id,
            summary: "different",
            artifacts: [{ kind: "uri", uri: "git:commit:present", name: "present" }],
          },
          "1",
          bridgeToken,
        )
      ).json(),
    ).toMatchObject({ error: { data: { code: "TASK_STATE_CONFLICT" } } });
    expect(await (await call("runtimes.probe", {})).json()).toMatchObject({
      result: { probe: { state: "ready" } },
    });
    const sessionsPage = record(
        await (
          await call("runtimes.sessions.list", {
            installationId: installation.id,
            availability: ["idle"],
            text: "worker",
            limit: 7,
          })
        ).json(),
      ),
      sessionsCursor = record(sessionsPage.result).nextCursor;
    expect(sessionsPage).toMatchObject({
      result: { sessions: [], nextCursor: expect.any(String) },
    });
    expect(sessionQuery).toEqual({
      availability: ["idle"],
      cursor: undefined,
      limit: 7,
      text: "worker",
    });
    if (typeof sessionsCursor !== "string") throw new Error("expected sessions cursor");
    await call("runtimes.sessions.list", {
      installationId: installation.id,
      cursor: sessionsCursor,
    });
    expect(sessionQuery).toMatchObject({ cursor: "next" });
    expect(
      await (
        await call("runtimes.sessions.list", {
          installationId: installation.id,
          cursor: `${sessionsCursor}x`,
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "VALIDATION_FAILED" } } });
    expect(
      await (await call("runtimes.sessions.list", { installationId: "ins_wrong" })).json(),
    ).toMatchObject({ error: { data: { code: "RUNTIME_UNAVAILABLE" } } });
    const runtimes = record(await (await call("runtimes.list", {})).json()),
      runtimeItems = record(runtimes.result).runtimes;
    if (!Array.isArray(runtimeItems)) throw new Error("missing runtimes list");
    const listedRuntime = record(runtimeItems[0]);
    expect(listedRuntime).toMatchObject({
      installationId: installation.id,
      probe: { state: "ready", capabilities: { appendContext: true }, diagnostics: [] },
    });
    expect(listedRuntime.state).toBeUndefined();
    const originalProbe = adapter.probe.bind(adapter);
    adapter.probe = async () => ({
      ...(await originalProbe()),
      capabilities: { ...adapter.descriptor.capabilities, appendContext: false },
    });
    expect(await (await call("system.capabilities", {})).json()).toMatchObject({
      result: { codex: { appendContext: false } },
    });
    adapter.probe = originalProbe;
    const now = Date.now();
    store.db
      .query(
        "INSERT INTO runtime_installations(id,harness_id,adapter_id,label,endpoint_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'offline',?,?)",
      )
      .run("ins_secondary", "other", "test.other", "secondary", "{}", now, now);
    const secondary = store.createAgent("secondary-agent"),
      secondaryBinding = store.bind(secondary.id, "secondary-thread", {
        installationId: "ins_secondary",
      });
    expect(
      await (await call("bindings.get", { bindingId: secondaryBinding.id })).json(),
    ).toMatchObject({ result: { binding: { harnessId: "other" } } });
    expect(await (await call("agents.get", { agent: secondary.id })).json()).toMatchObject({
      result: { agent: { binding: { harnessId: "other" } } },
    });
    const firstRuntimePage = await (await call("runtimes.list", { limit: 1 })).json(),
      runtimeCursor = record(record(firstRuntimePage).result).nextCursor;
    if (typeof runtimeCursor !== "string") throw new Error("expected runtime cursor");
    expect(firstRuntimePage).toMatchObject({
      result: { runtimes: [{ label: "local" }], nextCursor: expect.any(String) },
    });
    expect(
      await (await call("runtimes.list", { limit: 1, cursor: runtimeCursor })).json(),
    ).toMatchObject({ result: { runtimes: [{ label: "secondary" }] } });
    expect(
      await (
        await call("bindings.bind", {
          agent: "backend",
          installationId: "ins_wrong",
          session: "thread-2",
        })
      ).json(),
    ).toMatchObject({ error: { data: { code: "BINDING_CONFLICT" } } });
    expect(new Set(inspected)).toEqual(
      new Set([
        "thread-1",
        "claimed-thread",
        "claim-thief",
        "expired-thread",
        "invalid-thread",
        "new-claimed-thread",
      ]),
    );
    expect(inspected.length).toBeGreaterThan(1);
    expect((await call("agents.list", {}, "2")).status).toBe(426);
    expect(
      store.db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM audit_events WHERE action IN ('agent.create','binding.bind')",
        )
        .get()?.n,
    ).toBe(4);
    expect(await (await call("agents.delete", { agent: "backend" })).json()).toMatchObject({
      result: { deleted: true },
    });
    expect(store.authenticate(issuedToken)).toBeNull();
    const denied = (await call("agents.create", { slug: "forbidden" }, "1", bridgeToken)).json();
    expect(await denied).toMatchObject({ error: { message: "NOT_AUTHORIZED" } });
    expect((await call("agents.list", {}, "1", "invalid-token")).status).toBe(401);
    expect(
      store.db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM audit_events WHERE action='security.reject'",
        )
        .get()?.n,
    ).toBe(2);
    store.close();
  });
  test("filters stable keyset pages for control-plane lists", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-control-pages-"));
    roots.push(root);
    const paths: Paths = {
        data: join(root, "acs.db"),
        runtime: join(root, "control.sock"),
        token: join(root, "control.token"),
        bridgeToken: join(root, "bridge.token"),
        secret: join(root, "secret.key"),
      },
      store = new Store(paths),
      adapter = new FakeRuntimeAdapter();
    adapter.inspectSession = async (session) => ({
      session,
      availability: "idle",
      observedAt: new Date().toISOString(),
      attributes: {},
    });
    const installation = required(
        store.db
          .query<{ id: `ins_${string}` }, []>("SELECT id FROM runtime_installations LIMIT 1")
          .get(),
        "installation",
      ),
      handler = controlHandler(
        store,
        new Date().toISOString(),
        () => {},
        adapter,
        new CodexCallerAttestor(installation.id),
      ),
      token = readFileSync(paths.token, "utf8"),
      request = (method: string, params: unknown) =>
        handler(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "ACS-Control-Version": "1",
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
          }),
        ),
      call = async (method: string, params: unknown) =>
        page(await (await request(method, params)).json());
    const beta = store.createAgent("beta");
    store.createAgent("delta");
    const firstAgents = await call("agents.list", { limit: 1 });
    store.createAgent("alpha");
    const secondAgents = await call("agents.list", { limit: 1, cursor: firstAgents.nextCursor });
    expect(slugs(firstAgents.items)).toEqual(["beta"]);
    expect(slugs(secondAgents.items)).toEqual(["delta"]);
    expect(slugs((await call("agents.list", { text: "ELT" })).items)).toEqual(["delta"]);
    expect(
      await (
        await request("agents.update", {
          agent: "delta",
          slug: "reports-agent",
          skills: [
            { id: "reports", name: "Reporting", description: "Build reports", tags: ["data"] },
          ],
        })
      ).json(),
    ).toMatchObject({
      result: {
        agent: { slug: "reports-agent", skills: [{ id: "reports", tags: ["data"] }] },
      },
    });
    expect(slugs((await call("agents.list", { skill: "data" })).items)).toEqual(["reports-agent"]);

    const betaOldBinding = store.bind(beta.id, "beta-old"),
      betaBinding = store.bind(beta.id, "beta-current", { revokeExisting: true }),
      activeBindings = await call("bindings.list", { agent: "beta", status: ["active"] });
    expect(activeBindings.items.map((item) => item.id)).toEqual([betaBinding.id]);

    const principal = required(store.authenticate(token), "principal");
    for (const messageId of ["page-one", "page-two"])
      store.accept(
        beta.id,
        principal.id,
        Message.fromJSON({ messageId, role: Role.ROLE_USER, parts: [{ text: "work" }] }),
        {},
      );
    const deliveries = await call("deliveries.list", {
      targetAgent: "beta",
      state: ["pending"],
      limit: 1,
    });
    const moreDeliveries = await call("deliveries.list", {
      targetAgent: "beta",
      state: ["pending"],
      limit: 1,
      cursor: deliveries.nextCursor,
    });
    expect([...deliveries.items, ...moreDeliveries.items]).toHaveLength(2);
    expect(deliveries.items[0]).toMatchObject({
      taskId: expect.stringMatching(/^tsk_/),
      targetAgentId: beta.id,
      state: "pending",
      attemptCount: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(deliveries.items[0]?.target_agent_id).toBeUndefined();
    const selectedDelivery = deliveries.items[0]?.id,
      otherDelivery = moreDeliveries.items[0]?.id;
    if (typeof selectedDelivery !== "string" || typeof otherDelivery !== "string")
      throw new Error("missing delivery IDs");
    store.db
      .query("UPDATE delivery_intents SET pinned_binding_id=?,pinned_binding_epoch=? WHERE id=?")
      .run(betaOldBinding.id, betaOldBinding.epoch, selectedDelivery);
    expect(
      await (
        await request("bindings.retargetPending", {
          agent: "beta",
          fromBindingId: betaOldBinding.id,
          toBindingId: betaBinding.id,
          deliveryIds: [selectedDelivery, otherDelivery],
        })
      ).json(),
    ).toMatchObject({ result: { retargeted: 1 } });
    expect(
      store.db
        .query<{ id: string; pinned_binding_id: string | null }, [string, string]>(
          "SELECT id,pinned_binding_id FROM delivery_intents WHERE id IN (?,?) ORDER BY id",
        )
        .all(selectedDelivery, otherDelivery),
    ).toEqual(
      [
        { id: selectedDelivery, pinned_binding_id: betaBinding.id },
        { id: otherDelivery, pinned_binding_id: null },
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    store.db
      .query("UPDATE delivery_intents SET state='acceptance-unknown' WHERE id=?")
      .run(otherDelivery);
    expect(
      await (
        await request("deliveries.resolveUnknown", {
          deliveryId: otherDelivery,
          resolution: "accepted",
          evidence: "confirmed in Codex history",
        })
      ).json(),
    ).toMatchObject({ result: { delivery: { state: "accepted" } } });
    const resolutionAudit = store.db
      .query<{ details_json: string }, []>(
        "SELECT details_json FROM audit_events WHERE action='delivery.resolve-unknown' ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get();
    expect(record(JSON.parse(required(resolutionAudit, "resolution audit").details_json))).toEqual({
      resolution: "accepted",
      evidence: "confirmed in Codex history",
    });

    const inbox = await call("inbox.list", {
      evidence: evidence(betaBinding.sessionId),
      states: ["submitted"],
      limit: 1,
    });
    const moreInbox = await call("inbox.list", {
      evidence: evidence(betaBinding.sessionId),
      states: ["submitted"],
      limit: 1,
      cursor: inbox.nextCursor,
    });
    expect([...inbox.items, ...moreInbox.items]).toHaveLength(2);
    expect(inbox.items[0]).toMatchObject({
      contextId: expect.stringMatching(/^ctx_/),
      targetAgentId: beta.id,
      state: "submitted",
      stateVersion: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(inbox.items[0]?.status).toBeUndefined();
    store.close();
  });
});

function page(value: unknown) {
  const rpc = record(value),
    result = record(rpc.result),
    items = result.items;
  if (!Array.isArray(items)) throw new Error("expected page items");
  return {
    items: items.map(record),
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : undefined,
  };
}
function slugs(items: Record<string, unknown>[]) {
  return items.map((item) => item.slug);
}
function evidence(threadId?: string, harnessId = "codex") {
  return {
    harnessId,
    bridge: "mcp",
    metadata: threadId ? { threadId } : undefined,
    bridgeInstanceId: "test",
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${name}`);
  return value;
}

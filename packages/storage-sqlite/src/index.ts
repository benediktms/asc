import { Database } from "bun:sqlite";
import migration from "../../../storage/001_initial.sql" with { type: "text" };
import {
  agentSlug,
  BindingState,
  canonical,
  DeliveryState,
  id,
  TaskState,
  transition,
  transitionBinding,
  transitionDelivery,
} from "../../domain/src/index";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BindingId,
  RuntimeAvailability,
  RuntimeInstallationId,
  RuntimeProbeResult,
  RuntimeSessionRef,
} from "../../../contracts/runtime-adapter";
import { paths } from "../../config/src/index";
import { telemetry } from "../../observability/src/index";
import type {
  AgentRow,
  BindingOptions,
  BindingRow,
  ClaimBindingResult,
  DeliveryOptions,
  DeliveryIntentRow,
  SqlBinding,
  StoredArtifact,
  StoredAttestation,
  StoredMessage,
  StoredPart,
  StoredTask,
} from "../../ports/src/index";
import { z } from "zod";

const a2aAgentRole = 2;
export type {
  AgentRow,
  BindingRow,
  DeliveryIntentRow,
  StoredArtifact,
  StoredMessage,
  StoredPart,
  StoredTask,
} from "../../ports/src/index";
export { paths, type Paths } from "../../config/src/index";

const storedPartSchema = z.object({
    content: z
      .discriminatedUnion("$case", [
        z.object({ $case: z.literal("text"), value: z.string() }),
        z.object({ $case: z.literal("url"), value: z.string() }),
        z.object({ $case: z.literal("data"), value: z.json() }),
        z.object({ $case: z.literal("raw"), value: z.unknown() }),
      ])
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    filename: z.string(),
    mediaType: z.string(),
  }),
  storedMessageSchema = z.object({
    messageId: z.string(),
    contextId: z.string(),
    taskId: z.string(),
    role: z.number(),
    parts: z.array(storedPartSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string()),
    referenceTaskIds: z.array(z.string()),
  }),
  storedArtifactSchema = z.object({
    artifactId: z.string(),
    name: z.string(),
    description: z.string(),
    parts: z.array(storedPartSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string()),
  }),
  storedTaskSchema = z.object({
    id: z.string(),
    contextId: z.string(),
    status: z
      .object({ state: z.number(), message: storedMessageSchema.optional(), timestamp: z.string() })
      .optional(),
    artifacts: z.array(storedArtifactSchema),
    history: z.array(storedMessageSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

const taskStates: Record<TaskState, number> = {
  submitted: 1,
  working: 2,
  completed: 3,
  failed: 4,
  canceled: 5,
  "input-required": 6,
  rejected: 7,
  "auth-required": 8,
};
const deliveryStatus = "urn:agent-communications:delivery-status:v1";
const taskEventTypes: Record<TaskState, string> = {
  submitted: "task-created",
  working: "task-working",
  "input-required": "input-required",
  "auth-required": "input-required",
  completed: "task-completed",
  failed: "task-failed",
  canceled: "task-canceled",
  rejected: "task-rejected",
};

interface TaskRow {
  id: `tsk_${string}`;
  context_id: `ctx_${string}`;
  target_agent_id: `agt_${string}`;
  requester_principal_id: `prn_${string}`;
  requester_agent_id: `agt_${string}` | null;
  state: TaskState;
  cancellation_requested: number;
  summary: string | null;
  state_version: number;
  next_event_sequence: number;
  a2a_snapshot_json: string;
}
export function initFiles(target = paths()): string {
  mkdirSync(dirname(target.data), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(target.runtime), { recursive: true, mode: 0o700 });
  if ((statSync(dirname(target.runtime)).mode & 0o777) !== 0o700)
    throw new Error("VALIDATION_FAILED: runtime directory must have mode 0700");
  if (!Bun.file(target.secret).size) writeFileSync(target.secret, randomBytes(32));
  chmodSync(target.secret, 0o600);
  if (!Bun.file(target.token).size)
    writeFileSync(target.token, randomBytes(32).toString("base64url"));
  chmodSync(target.token, 0o600);
  if (!Bun.file(target.bridgeToken).size)
    writeFileSync(target.bridgeToken, randomBytes(32).toString("base64url"));
  chmodSync(target.bridgeToken, 0o600);
  return readFileSync(target.token, "utf8");
}

export class Store {
  readonly db: Database;
  readonly secret: Buffer;
  readonly limits: {
    maxInlineContentBytes: number;
    maxParts: number;
    maxTextPartBytes: number;
    claimTtlSeconds: number;
    maxQueuedDeliveryIntents: number;
    busyTimeoutMs: number;
    durability: "balanced" | "strict";
  };
  constructor(
    readonly config = paths(),
    limits: Partial<Store["limits"]> = {},
  ) {
    this.limits = {
      maxInlineContentBytes: 262144,
      maxParts: 32,
      maxTextPartBytes: 65536,
      claimTtlSeconds: 600,
      maxQueuedDeliveryIntents: 1000,
      busyTimeoutMs: 5000,
      durability: "balanced",
      ...limits,
    };
    initFiles(config);
    this.db = new Database(config.data, { create: true, strict: true });
    this.db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${this.limits.busyTimeoutMs}; PRAGMA synchronous=${this.limits.durability === "strict" ? "FULL" : "NORMAL"};`,
    );
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get()) {
      this.db.exec(migration);
      this.db
        .query(
          "INSERT INTO schema_migrations(version,name,checksum,applied_at_ms) VALUES(1,'initial',?,?)",
        )
        .run(createHash("sha256").update(migration).digest("hex"), Date.now());
    }
    this.secret = readFileSync(config.secret);
    this.bootstrap();
  }
  close() {
    this.db.close();
  }
  write<T>(operation: () => T): T {
    try {
      return this.db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message))
        telemetry.increment("acs_sqlite_busy_total");
      throw error;
    }
  }
  query<Result = unknown, Params extends SqlBinding[] = SqlBinding[]>(sql: string) {
    return this.db.query<Result, Params>(sql);
  }
  metrics() {
    for (const state of Object.values(TaskState))
      telemetry.gauge("acs_tasks_by_state", 0, { state });
    for (const state of Object.values(DeliveryState))
      telemetry.gauge("acs_delivery_intents_by_state", 0, { state });
    for (const state of [
      "unknown",
      "offline",
      "dormant",
      "idle",
      "busy",
      "awaiting-local-input",
      "degraded",
    ])
      telemetry.gauge("acs_runtime_sessions_by_state", 0, { state });
    for (const row of this.db
      .query<{ state: string; count: number }, []>(
        "SELECT state,count(*) count FROM a2a_tasks GROUP BY state",
      )
      .all())
      telemetry.gauge("acs_tasks_by_state", row.count, { state: row.state });
    for (const row of this.db
      .query<{ state: string; count: number }, []>(
        "SELECT state,count(*) count FROM delivery_intents GROUP BY state",
      )
      .all())
      telemetry.gauge("acs_delivery_intents_by_state", row.count, { state: row.state });
    for (const row of this.db
      .query<{ state: string; count: number }, []>(
        "SELECT coalesce(last_observed_availability,'unknown') state,count(*) count FROM runtime_bindings WHERE status='active' GROUP BY state",
      )
      .all())
      telemetry.gauge("acs_runtime_sessions_by_state", row.count, { state: row.state });
    return telemetry.snapshot();
  }
  hashToken(token: string) {
    return createHmac("sha256", this.secret).update(token).digest();
  }
  payloadHash(value: unknown) {
    return createHash("sha256").update(canonical(value)).digest("hex");
  }
  encodeCursor(value: Record<string, unknown>) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url"),
      mac = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }
  decodeCursor(cursor: string): unknown {
    const [payload, signature, extra] = cursor.split("."),
      expected = payload
        ? createHmac("sha256", this.secret).update(payload).digest("base64url")
        : "";
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new Error("VALIDATION_FAILED: invalid cursor");
    return JSON.parse(Buffer.from(payload, "base64url").toString());
  }
  audit(
    actorPrincipalId: string | null,
    action: string,
    resourceType: string,
    resourceId?: string,
    details: Record<string, unknown> = {},
    correlationId: string = crypto.randomUUID(),
  ) {
    this.db
      .query(
        "INSERT INTO audit_events(id,actor_principal_id,action,resource_type,resource_id,correlation_id,details_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id("evt"),
        actorPrincipalId,
        action,
        resourceType,
        resourceId ?? null,
        correlationId,
        JSON.stringify(details),
        Date.now(),
      );
  }
  private bootstrap() {
    const principal = this.db
      .query<{ id: `prn_${string}` }, []>(
        "SELECT id FROM principals WHERE kind='local-user' LIMIT 1",
      )
      .get();
    if (principal) return;
    const now = Date.now(),
      principalId = id("prn"),
      tokenId = id("tok"),
      token = readFileSync(this.config.token, "utf8"),
      bridgePrincipalId = id("prn");
    this.write(() => {
      this.db
        .query(
          "INSERT INTO principals(id,kind,display_name,scopes_json,created_at_ms) VALUES(?,?,?,?,?)",
        )
        .run(principalId, "local-user", "Local user", '["*"]', now);
      this.db
        .query(
          "INSERT INTO auth_tokens(id,principal_id,token_hash,token_hint,scopes_json,issued_at_ms) VALUES(?,?,?,?,?,?)",
        )
        .run(tokenId, principalId, this.hashToken(token), token.slice(0, 6), '["*"]', now);
      const bridgeToken = readFileSync(this.config.bridgeToken, "utf8");
      this.db
        .query(
          "INSERT INTO principals(id,kind,display_name,scopes_json,created_at_ms) VALUES(?,?,?,?,?)",
        )
        .run(
          bridgePrincipalId,
          "service",
          "Codex MCP bridge",
          '["agents:read","bridge:attest","bridge:token","inbox","executor"]',
          now,
        );
      this.db
        .query(
          "INSERT INTO auth_tokens(id,principal_id,token_hash,token_hint,scopes_json,issued_at_ms) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id("tok"),
          bridgePrincipalId,
          this.hashToken(bridgeToken),
          bridgeToken.slice(0, 6),
          '["agents:read","bridge:attest","bridge:token","inbox","executor"]',
          now,
        );
      this.db
        .query(
          "INSERT INTO runtime_installations(id,harness_id,adapter_id,label,endpoint_json,capabilities_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id("ins"),
          "codex",
          "codex.app-server",
          "local",
          '{"kind":"local"}',
          "{}",
          "unknown",
          now,
          now,
        );
    });
  }
  authenticate(token: string) {
    const rows = this.db
      .query<
        {
          id: `prn_${string}`;
          kind: string;
          agent_id: `agt_${string}` | null;
          binding_id: BindingId | null;
          token_id: `tok_${string}`;
          token_hash: Uint8Array;
          scopes_json: string;
        },
        [number]
      >(
        "SELECT p.id,p.kind,p.agent_id,p.binding_id,t.id token_id,t.token_hash,t.scopes_json FROM auth_tokens t JOIN principals p ON p.id=t.principal_id WHERE t.revoked_at_ms IS NULL AND p.disabled_at_ms IS NULL AND (t.expires_at_ms IS NULL OR t.expires_at_ms>?)",
      )
      .all(Date.now());
    const hash = this.hashToken(token);
    const row = rows.find((candidate) => timingSafeEqual(hash, Buffer.from(candidate.token_hash)));
    if (!row) return null;
    this.db
      .query("UPDATE auth_tokens SET last_used_at_ms=? WHERE id=?")
      .run(Date.now(), row.token_id);
    return { ...row, scopes: stringArray(row.scopes_json) };
  }
  createToken(kind: "external-a2a-client" | "service" = "external-a2a-client") {
    const now = Date.now(),
      principalId = id("prn"),
      tokenId = id("tok"),
      token = randomBytes(32).toString("base64url");
    this.write(() => {
      this.db
        .query(
          "INSERT INTO principals(id,kind,display_name,scopes_json,created_at_ms) VALUES(?,?,?,?,?)",
        )
        .run(principalId, kind, kind, '["a2a:send","a2a:read","a2a:cancel"]', now);
      this.db
        .query(
          "INSERT INTO auth_tokens(id,principal_id,token_hash,token_hint,scopes_json,issued_at_ms) VALUES(?,?,?,?,?,?)",
        )
        .run(
          tokenId,
          principalId,
          this.hashToken(token),
          token.slice(0, 6),
          '["a2a:send","a2a:read","a2a:cancel"]',
          now,
        );
    });
    this.audit(principalId, "token.issue", "token", tokenId, { kind });
    return { token, principalId };
  }
  createAgent(slugValue: string, displayName?: string, description = "", skills: unknown[] = []) {
    const slug = agentSlug(slugValue),
      agentId = id("agt"),
      now = Date.now();
    this.db
      .query(
        "INSERT INTO agents(id,slug,display_name,description,skills_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
      )
      .run(agentId, slug, displayName ?? slug, description, JSON.stringify(skills), now, now);
    return must(this.agent(slug), "AGENT_NOT_FOUND");
  }
  updateAgent(
    value: string,
    patch: {
      slug?: string;
      displayName?: string;
      description?: string;
      enabled?: boolean;
      skills?: unknown[];
    },
  ) {
    const agent = this.agent(value);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    this.db
      .query(
        "UPDATE agents SET slug=?,display_name=?,description=?,enabled=?,skills_json=?,profile_revision=profile_revision+1,updated_at_ms=? WHERE id=?",
      )
      .run(
        patch.slug ? agentSlug(patch.slug) : agent.slug,
        patch.displayName ?? agent.display_name,
        patch.description ?? agent.description,
        patch.enabled === undefined ? agent.enabled : Number(patch.enabled),
        JSON.stringify(patch.skills ?? JSON.parse(agent.skills_json)),
        Date.now(),
        agent.id,
      );
    return must(this.agent(agent.id), "AGENT_NOT_FOUND");
  }
  deleteAgent(value: string) {
    const agent = this.agent(value);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const now = Date.now();
    this.write(() => {
      const revoked = transitionBinding(BindingState.Active, BindingState.Revoked);
      this.db
        .query("UPDATE agents SET enabled=0,deleted_at_ms=?,updated_at_ms=? WHERE id=?")
        .run(now, now, agent.id);
      this.db
        .query(
          "UPDATE runtime_bindings SET status=?,revoked_at_ms=?,revocation_reason='agent-deleted' WHERE agent_id=? AND status='active'",
        )
        .run(revoked, now, agent.id);
      this.db
        .query(
          "UPDATE principals SET disabled_at_ms=? WHERE binding_id IN (SELECT id FROM runtime_bindings WHERE agent_id=?) AND disabled_at_ms IS NULL",
        )
        .run(now, agent.id);
    });
  }
  agent(value: string) {
    return this.db
      .query<AgentRow, [string, string]>(
        "SELECT * FROM agents WHERE deleted_at_ms IS NULL AND (id=? OR slug=?)",
      )
      .get(value, value.replace(/^@/, ""));
  }
  agents() {
    return this.db
      .query<AgentRow, []>("SELECT * FROM agents WHERE deleted_at_ms IS NULL ORDER BY slug")
      .all();
  }
  bind(agentValue: string, sessionId: string, options: BindingOptions = {}) {
    const agent = this.agent(agentValue);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const installation = must(
        options.installationId
          ? this.db
              .query<{ id: RuntimeInstallationId }, [RuntimeInstallationId]>(
                "SELECT id FROM runtime_installations WHERE id=? LIMIT 1",
              )
              .get(options.installationId)
          : this.db
              .query<{ id: RuntimeInstallationId }, []>(
                "SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1",
              )
              .get(),
        "STORAGE_CORRUPT: runtime installation missing",
      ),
      policy = {
        interruptOnCancel: options.deliveryPolicy?.interruptOnCancel ?? false,
      };
    return this.write(() => {
      const active = this.db
        .query<{ id: BindingId }, [`agt_${string}`]>(
          "SELECT id FROM runtime_bindings WHERE agent_id=? AND status='active'",
        )
        .get(agent.id);
      if (active && !options.revokeExisting)
        throw new Error("BINDING_CONFLICT: agent already has an active binding; rebind required");
      const sessionOwner = this.db
        .query<{ agent_id: `agt_${string}` }, [RuntimeInstallationId, string]>(
          "SELECT agent_id FROM runtime_bindings WHERE installation_id=? AND session_opaque_id=? AND status='active'",
        )
        .get(installation.id, sessionId);
      if (sessionOwner && sessionOwner.agent_id !== agent.id)
        throw new Error("BINDING_CONFLICT: session already belongs to another agent");
      const now = Date.now(),
        bindingId = id("bnd"),
        activeState = transitionBinding(BindingState.Pending, BindingState.Active),
        epoch =
          (must(
            this.db
              .query<{ value: number | null }, [`agt_${string}`]>(
                "SELECT max(epoch) value FROM runtime_bindings WHERE agent_id=?",
              )
              .get(agent.id),
            "STORAGE_CORRUPT: binding epoch query failed",
          ).value ?? 0) + 1;
      this.db
        .query(
          "UPDATE principals SET disabled_at_ms=? WHERE binding_id IN (SELECT id FROM runtime_bindings WHERE agent_id=? AND status='active') AND disabled_at_ms IS NULL",
        )
        .run(now, agent.id);
      this.db
        .query(
          "UPDATE runtime_bindings SET status=?,revoked_at_ms=?,revocation_reason='rebound' WHERE agent_id=? AND status='active'",
        )
        .run(transitionBinding(BindingState.Active, BindingState.Revoked), now, agent.id);
      this.db
        .query(
          "INSERT INTO runtime_bindings(id,agent_id,installation_id,session_opaque_id,epoch,status,continuity_policy,delivery_policy_json,created_at_ms,activated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          bindingId,
          agent.id,
          installation.id,
          sessionId,
          epoch,
          activeState,
          options.continuityPolicy ?? "follow-pending",
          JSON.stringify(policy),
          now,
          now,
        );
      const principalId = id("prn");
      this.db
        .query(
          "INSERT INTO principals(id,kind,agent_id,binding_id,display_name,scopes_json,created_at_ms) VALUES(?,'bound-agent',?,?,?,?,?)",
        )
        .run(
          principalId,
          agent.id,
          bindingId,
          agent.slug,
          '["a2a:send","a2a:read","a2a:cancel","executor","inbox"]',
          now,
        );
      this.db
        .query(
          "UPDATE delivery_intents SET not_before_ms=?,updated_at_ms=? WHERE target_agent_id=? AND state='deferred' AND state_reason IN ('offline','dormant','local-input','unsupported-active-state','route-unavailable','policy')",
        )
        .run(now, now, agent.id);
      return {
        id: bindingId,
        agentId: agent.id,
        sessionId,
        epoch,
        principalId,
        rebound: active !== null,
      };
    });
  }
  binding(bindingId: string) {
    return this.db
      .query<BindingRow, [string]>("SELECT * FROM runtime_bindings WHERE id=?")
      .get(bindingId);
  }
  observeSession(session: RuntimeSessionRef, availability: RuntimeAvailability) {
    const now = Date.now();
    this.db
      .query(
        "UPDATE runtime_bindings SET last_observed_availability=?,last_observed_at_ms=? WHERE installation_id=? AND session_opaque_id=? AND status='active'",
      )
      .run(availability, now, session.installationId, session.opaqueId);
  }
  observeRuntime(installationId: RuntimeInstallationId, probe: RuntimeProbeResult) {
    const state = probe.state === "ready" ? "online" : probe.state;
    this.db
      .query(
        "UPDATE runtime_installations SET state=?,capabilities_json=?,protocol_fingerprint=?,last_seen_at_ms=?,updated_at_ms=? WHERE id=?",
      )
      .run(
        state,
        JSON.stringify(probe.capabilities),
        probe.protocolFingerprint ?? null,
        Date.parse(probe.observedAt),
        Date.now(),
        installationId,
      );
  }
  markRuntimeOffline(installationId: RuntimeInstallationId) {
    const now = Date.now();
    this.db
      .query("UPDATE runtime_installations SET state='offline',updated_at_ms=? WHERE id=?")
      .run(now, installationId);
  }
  revokeBinding(bindingId: string, reason = "revoked") {
    const binding = this.binding(bindingId);
    if (!binding) throw new Error("BINDING_NOT_FOUND");
    const now = Date.now();
    this.write(() => {
      const revoked = transitionBinding(binding.status, BindingState.Revoked);
      this.db
        .query(
          "UPDATE runtime_bindings SET status=?,revoked_at_ms=?,revocation_reason=? WHERE id=?",
        )
        .run(revoked, now, reason, bindingId);
      this.db
        .query(
          "UPDATE principals SET disabled_at_ms=? WHERE binding_id=? AND disabled_at_ms IS NULL",
        )
        .run(now, bindingId);
    });
    return this.binding(bindingId);
  }
  createClaim(agentValue: string, principalId: string, ttlSeconds = this.limits.claimTtlSeconds) {
    const agent = this.agent(agentValue);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const claimCode = bindingClaimCode(),
      claimId = id("clm"),
      now = Date.now(),
      expires = now + Math.min(Math.max(ttlSeconds, 1), 3600) * 1000;
    this.db
      .query(
        "INSERT INTO binding_claims(id,agent_id,code_hash,created_by_principal_id,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?)",
      )
      .run(claimId, agent.id, this.hashToken(claimCode), principalId, now, expires);
    return { claimId, claimCode, expiresAt: new Date(expires).toISOString() };
  }
  claim(code: string, sessionId: string, options: BindingOptions = {}): ClaimBindingResult {
    return this.write(() => {
      const verifier = this.hashToken(code),
        matches = this.db
          .query<
            {
              id: `clm_${string}`;
              agent_id: `agt_${string}`;
              code_hash: Uint8Array;
              expires_at_ms: number;
              consumed_at_ms: number | null;
              consumed_by_binding_id: BindingId | null;
            },
            [Uint8Array]
          >(
            "SELECT id,agent_id,code_hash,expires_at_ms,consumed_at_ms,consumed_by_binding_id FROM binding_claims WHERE code_hash=? LIMIT 2",
          )
          .all(verifier);
      if (matches.length > 1) throw new Error("CLAIM_AMBIGUOUS");
      const row = matches.at(0);
      if (!row) throw new Error("CLAIM_INVALID");
      if (row.consumed_at_ms !== null) {
        const consumed = row.consumed_by_binding_id
          ? this.db
              .query<
                {
                  id: BindingId;
                  agent_id: `agt_${string}`;
                  installation_id: RuntimeInstallationId;
                  session_opaque_id: string;
                  epoch: number;
                  status: BindingState;
                  principal_id: `prn_${string}`;
                },
                [BindingId]
              >(
                "SELECT b.id,b.agent_id,b.installation_id,b.session_opaque_id,b.epoch,b.status,p.id principal_id FROM runtime_bindings b JOIN principals p ON p.binding_id=b.id WHERE b.id=?",
              )
              .get(row.consumed_by_binding_id)
          : null;
        if (!consumed) throw new Error("STORAGE_CORRUPT: consumed claim binding missing");
        if (
          (options.installationId !== undefined &&
            consumed.installation_id !== options.installationId) ||
          consumed.session_opaque_id !== sessionId
        )
          throw new Error("CLAIM_CONSUMED: claim belongs to another session");
        if (consumed.status !== BindingState.Active)
          throw new Error("STALE_BINDING: consumed claim binding is no longer active");
        return {
          id: consumed.id,
          agentId: consumed.agent_id,
          sessionId: consumed.session_opaque_id,
          epoch: consumed.epoch,
          principalId: consumed.principal_id,
          idempotent: true,
          rebound: false,
        };
      }
      if (row.expires_at_ms <= Date.now()) throw new Error("CLAIM_EXPIRED");
      const binding = this.bind(row.agent_id, sessionId, options),
        consumed = this.db
          .query(
            "UPDATE binding_claims SET consumed_at_ms=?,consumed_by_binding_id=? WHERE id=? AND consumed_at_ms IS NULL",
          )
          .run(Date.now(), binding.id, row.id);
      if (consumed.changes !== 1) throw new Error("CLAIM_CONSUMED");
      return {
        ...binding,
        idempotent: false,
      };
    });
  }
  attestSession(
    session: RuntimeSessionRef,
    scheme: string,
    evidenceFingerprint: string,
  ): StoredAttestation {
    const row = this.db
      .query<
        {
          installation_id: RuntimeInstallationId;
          binding_id: BindingId;
          epoch: number;
          agent_id: `agt_${string}`;
          principal_id: `prn_${string}`;
          slug: string;
          display_name: string;
        },
        [RuntimeInstallationId, string]
      >(
        "SELECT b.installation_id,b.id binding_id,b.epoch,b.agent_id,p.id principal_id,a.slug,a.display_name FROM runtime_bindings b JOIN principals p ON p.binding_id=b.id JOIN agents a ON a.id=b.agent_id WHERE b.installation_id=? AND b.session_opaque_id=? AND b.status='active' AND p.disabled_at_ms IS NULL",
      )
      .get(session.installationId, session.opaqueId);
    return row
      ? {
          kind: "attested",
          scheme,
          session,
          bindingId: row.binding_id,
          bindingEpoch: row.epoch,
          agentId: row.agent_id,
          principalId: row.principal_id,
          slug: row.slug,
          displayName: row.display_name,
          evidenceFingerprint,
        }
      : { kind: "unattested", reason: "unbound-session" };
  }
  issueToken(principalId: string, scopes: readonly string[], ttlSeconds = 300) {
    const token = randomBytes(32).toString("base64url"),
      now = Date.now();
    this.db
      .query(
        "INSERT INTO auth_tokens(id,principal_id,token_hash,token_hint,scopes_json,issued_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id("tok"),
        principalId,
        this.hashToken(token),
        token.slice(0, 6),
        JSON.stringify(scopes),
        now,
        now + ttlSeconds * 1000,
      );
    this.audit(principalId, "token.issue", "token", undefined, { ttlSeconds });
    return token;
  }
  inbox(agentId: string) {
    return this.db
      .query<
        { id: string; state: TaskState; updated_at_ms: number; a2a_snapshot_json: string },
        [string]
      >(
        "SELECT id,state,updated_at_ms,a2a_snapshot_json FROM a2a_tasks WHERE target_agent_id=? ORDER BY updated_at_ms DESC,id DESC",
      )
      .all(agentId)
      .map((row) => ({
        id: row.id,
        state: row.state,
        updated_at_ms: row.updated_at_ms,
        task: this.taskSnapshot(row.id, row.a2a_snapshot_json),
      }));
  }
  inboxTask(agentId: string, taskId: string) {
    const row = this.db
      .query<{ a2a_snapshot_json: string }, [string, string]>(
        "SELECT a2a_snapshot_json FROM a2a_tasks WHERE id=? AND target_agent_id=?",
      )
      .get(taskId, agentId);
    return row ? JSON.parse(row.a2a_snapshot_json) : undefined;
  }
  task(idValue: string, principalId: string, targetAgentId?: string): StoredTask | undefined {
    return this.taskStreamState(idValue, principalId, targetAgentId)?.task;
  }
  taskStreamState(idValue: string, principalId: string, targetAgentId?: string) {
    const row = this.db
      .query<
        { a2a_snapshot_json: string; sequence: number },
        [string, string, string | null, string | null, string]
      >(
        "SELECT t.a2a_snapshot_json,t.next_event_sequence-1 sequence FROM a2a_tasks t LEFT JOIN principals p ON p.id=? WHERE t.id=? AND (? IS NULL OR t.target_agent_id=?) AND (t.requester_principal_id=? OR p.agent_id=t.target_agent_id)",
      )
      .get(principalId, idValue, targetAgentId ?? null, targetAgentId ?? null, principalId);
    return row
      ? { task: this.taskSnapshot(idValue, row.a2a_snapshot_json), sequence: row.sequence }
      : undefined;
  }
  taskVersion(taskId: string) {
    return must(
      this.db
        .query<{ state_version: number }, [string]>(
          "SELECT state_version FROM a2a_tasks WHERE id=?",
        )
        .get(taskId),
      "TASK_NOT_FOUND",
    ).state_version;
  }
  listTasks(
    agentId: string,
    principalId: string,
    options: {
      contextId?: string;
      states?: readonly string[];
      updatedAfterMs?: number;
      cursor?: string;
      limit: number;
    },
  ) {
    const cursor = options.cursor ? pageCursor(this.decodeCursor(options.cursor)) : undefined,
      params: [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        number,
      ] = [
        agentId,
        principalId,
        options.contextId ?? null,
        options.contextId ?? null,
        options.states?.length ? JSON.stringify(options.states) : null,
        options.states?.length ? JSON.stringify(options.states) : null,
        options.updatedAfterMs ?? null,
        options.updatedAfterMs ?? null,
        cursor?.sortKey ?? null,
        cursor?.sortKey ?? null,
        cursor?.sortKey ?? null,
        cursor?.id ?? null,
        options.limit + 1,
      ],
      rows = this.db
        .query<{ id: string; updated_at_ms: number; a2a_snapshot_json: string }, typeof params>(
          "SELECT id,updated_at_ms,a2a_snapshot_json FROM a2a_tasks WHERE target_agent_id=? AND requester_principal_id=? AND (? IS NULL OR context_id=?) AND (? IS NULL OR state IN (SELECT value FROM json_each(?))) AND (? IS NULL OR updated_at_ms>=?) AND (? IS NULL OR updated_at_ms<? OR (updated_at_ms=? AND id<?)) ORDER BY updated_at_ms DESC,id DESC LIMIT ?",
        )
        .all(...params),
      page = rows.slice(0, options.limit),
      last = page.at(-1),
      total = must(
        this.db
          .query<
            { count: number },
            [
              string,
              string,
              string | null,
              string | null,
              string | null,
              string | null,
              number | null,
              number | null,
            ]
          >(
            "SELECT count(*) count FROM a2a_tasks WHERE target_agent_id=? AND requester_principal_id=? AND (? IS NULL OR context_id=?) AND (? IS NULL OR state IN (SELECT value FROM json_each(?))) AND (? IS NULL OR updated_at_ms>=?)",
          )
          .get(
            agentId,
            principalId,
            options.contextId ?? null,
            options.contextId ?? null,
            options.states?.length ? JSON.stringify(options.states) : null,
            options.states?.length ? JSON.stringify(options.states) : null,
            options.updatedAfterMs ?? null,
            options.updatedAfterMs ?? null,
          ),
        "STORAGE_CORRUPT: task count query failed",
      ).count;
    return {
      tasks: page.map((row) => this.taskSnapshot(row.id, row.a2a_snapshot_json)),
      nextCursor:
        rows.length > options.limit && last
          ? this.encodeCursor({ sortKey: last.updated_at_ms, id: last.id })
          : undefined,
      total,
    };
  }
  eventSequence(taskId: string) {
    return Number(
      this.db
        .query<{ sequence: number | null }, [string]>(
          "SELECT max(sequence) sequence FROM task_events WHERE task_id=?",
        )
        .get(taskId)?.sequence ?? 0,
    );
  }
  eventsAfter(taskId: string, sequence: number) {
    return this.db
      .query<
        { sequence: number; event_type: string; payload_json: string; created_at_ms: number },
        [string, number]
      >(
        "SELECT sequence,event_type,payload_json,created_at_ms FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence",
      )
      .all(taskId, sequence)
      .map((row) => {
        const payload: unknown = JSON.parse(row.payload_json),
          snapshot = isRecord(payload) ? storedTaskSchema.safeParse(payload.snapshot) : undefined;
        if (!snapshot?.success) throw new Error("STORAGE_CORRUPT: invalid task event snapshot");
        return {
          sequence: row.sequence,
          eventType: row.event_type,
          task: this.taskSnapshot(taskId, JSON.stringify(snapshot.data)),
          createdAt: new Date(row.created_at_ms).toISOString(),
        };
      });
  }
  private taskSnapshot(taskId: string, snapshotJson: string): StoredTask {
    const task = parseTask(snapshotJson),
      delivery = this.db
        .query<
          { id: string; state: DeliveryState; state_reason: string | null; attempt_count: number },
          [string]
        >(
          "SELECT id,state,state_reason,attempt_count FROM delivery_intents WHERE task_id=? AND kind='a2a-message' ORDER BY rowid DESC LIMIT 1",
        )
        .get(taskId);
    if (!delivery) return task;
    return {
      ...task,
      metadata: {
        ...task.metadata,
        [deliveryStatus]: {
          state: delivery.state === DeliveryState.Pending ? "queued" : delivery.state,
          deliveryId: delivery.id,
          attemptCount: delivery.attempt_count,
          ...(delivery.state_reason ? { reason: delivery.state_reason } : {}),
        },
      },
    };
  }
  verifyTaskProjections(repair = false) {
    const rows = this.db
        .query<
          {
            id: string;
            state: TaskState;
            a2a_snapshot_json: string;
            event_payload_json: string | null;
          },
          []
        >(
          "SELECT t.id,t.state,t.a2a_snapshot_json,(SELECT e.payload_json FROM task_events e WHERE e.task_id=t.id AND json_type(e.payload_json,'$.snapshot')='object' ORDER BY e.sequence DESC LIMIT 1) event_payload_json FROM a2a_tasks t ORDER BY t.id",
        )
        .all(),
      mismatched: string[] = [],
      missing: string[] = [],
      repairs: { id: string; state: TaskState; snapshot: StoredTask }[] = [];
    for (const row of rows) {
      const payload: unknown = row.event_payload_json ? JSON.parse(row.event_payload_json) : null,
        rebuilt = isRecord(payload) ? storedTaskSchema.safeParse(payload.snapshot) : undefined;
      if (!rebuilt?.success) {
        missing.push(row.id);
        continue;
      }
      const state = taskState(rebuilt.data);
      if (
        canonical(rebuilt.data) === canonical(parseTask(row.a2a_snapshot_json)) &&
        state === row.state
      )
        continue;
      mismatched.push(row.id);
      repairs.push({ id: row.id, state, snapshot: rebuilt.data });
    }
    if (repair && repairs.length)
      this.write(() => {
        for (const item of repairs)
          this.db
            .query("UPDATE a2a_tasks SET state=?,a2a_snapshot_json=? WHERE id=?")
            .run(item.state, JSON.stringify(item.snapshot), item.id);
      });
    return { checked: rows.length, mismatched, missing, repaired: repair ? repairs.length : 0 };
  }
  accept(
    agentId: string,
    principalId: string,
    message: StoredMessage,
    options: DeliveryOptions,
    requestHash?: string,
  ): { task: StoredTask; deliveryId: string; duplicate: boolean; stateVersion?: number } {
    return telemetry.traceSync("task.accept", () =>
      this.acceptTask(agentId, principalId, message, options, requestHash),
    );
  }
  private acceptTask(
    agentId: string,
    principalId: string,
    message: StoredMessage,
    options: DeliveryOptions,
    canonicalRequestHash?: string,
  ): { task: StoredTask; deliveryId: string; duplicate: boolean; stateVersion?: number } {
    const target = this.agent(agentId);
    if (!target) throw new Error("AGENT_NOT_FOUND");
    if (!target.enabled) throw new Error("ACS_AGENT_DISABLED");
    if (!message.messageId || !message.parts.length)
      throw new Error("VALIDATION_FAILED: messageId and parts are required");
    if (message.parts.length > this.limits.maxParts) throw new Error("ACS_MESSAGE_TOO_LARGE");
    let bytes = 0;
    for (const part of message.parts) {
      if (!part.content || part.content.$case === "raw") throw new Error("ACS_UNSUPPORTED_CONTENT");
      if (
        part.content.$case === "text" &&
        Buffer.byteLength(part.content.value) > this.limits.maxTextPartBytes
      )
        throw new Error("ACS_MESSAGE_TOO_LARGE");
      bytes += Buffer.byteLength(JSON.stringify(part));
    }
    if (bytes > this.limits.maxInlineContentBytes) throw new Error("ACS_MESSAGE_TOO_LARGE");
    const scope = `${principalId}:${agentId}`,
      requestHash = canonicalRequestHash ?? this.payloadHash({ message, options });
    return this.write(() => {
      const existing = this.db
        .query<{ request_hash: string; response_json: string }, [string, string]>(
          "SELECT request_hash,response_json FROM idempotency_records WHERE scope=? AND key=?",
        )
        .get(scope, message.messageId);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("ACS_IDEMPOTENCY_CONFLICT");
        const response: unknown = JSON.parse(existing.response_json);
        if (
          !isRecord(response) ||
          !isRecord(response.task) ||
          typeof response.task.id !== "string" ||
          typeof response.deliveryId !== "string"
        )
          throw new Error("STORAGE_CORRUPT: invalid idempotency response");
        const current = this.db
          .query<{ a2a_snapshot_json: string; state_version: number }, [string]>(
            "SELECT a2a_snapshot_json,state_version FROM a2a_tasks WHERE id=?",
          )
          .get(response.task.id);
        if (!current) throw new Error("STORAGE_CORRUPT: idempotent task missing");
        return {
          task: this.taskSnapshot(response.task.id, current.a2a_snapshot_json),
          deliveryId: response.deliveryId,
          stateVersion: current.state_version,
          duplicate: true,
        };
      }
      const queued = must(
        this.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) count FROM delivery_intents WHERE target_agent_id=? AND state IN ('pending','leased','attempting','deferred','acceptance-unknown')",
          )
          .get(agentId),
        "STORAGE_CORRUPT: delivery count query failed",
      ).count;
      if (queued >= this.limits.maxQueuedDeliveryIntents) throw new Error("ACS_OVERLOADED");
      const now = Date.now(),
        contextId = message.contextId || id("ctx"),
        taskId = message.taskId || id("tsk"),
        messageRowId = id("msg"),
        deliveryId = id("int");
      const requester = must(
        this.db
          .query<{ agent_id: `agt_${string}` | null; binding_id: BindingId | null }, [string]>(
            "SELECT agent_id,binding_id FROM principals WHERE id=?",
          )
          .get(principalId),
        "NOT_AUTHENTICATED",
      );
      const continuation = message.taskId
        ? this.db.query<TaskRow, [string]>("SELECT * FROM a2a_tasks WHERE id=?").get(message.taskId)
        : null;
      if (
        continuation &&
        (continuation.requester_principal_id !== principalId ||
          continuation.target_agent_id !== agentId ||
          (message.contextId && message.contextId !== continuation.context_id))
      )
        throw new Error("ACS_TASK_STATE_CONFLICT");
      if (message.taskId && !continuation) throw new Error("ACS_TASK_NOT_VISIBLE");
      let state: TaskState = continuation?.state ?? TaskState.Submitted;
      if (continuation?.state === TaskState.InputRequired)
        state = transition(state, TaskState.Working);
      if (["completed", "failed", "canceled", "rejected"].includes(state))
        throw new Error("ACS_TASK_STATE_CONFLICT");
      if (!continuation)
        this.db
          .query(
            "INSERT INTO conversation_contexts(id,target_agent_id,requester_principal_id,requester_agent_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)",
          )
          .run(contextId, agentId, principalId, requester.agent_id, now, now);
      const inbound: StoredMessage = { ...message, contextId, taskId };
      const history = continuation
        ? [...(JSON.parse(continuation.a2a_snapshot_json).history ?? []), inbound]
        : [inbound];
      const task: StoredTask = {
        id: taskId,
        contextId,
        status: {
          state: taskStates[state],
          message: undefined,
          timestamp: new Date(now).toISOString(),
        },
        artifacts: continuation ? (JSON.parse(continuation.a2a_snapshot_json).artifacts ?? []) : [],
        history,
        metadata: {
          "urn:agent-communications:delivery-status:v1": { state: "queued", deliveryId },
        },
      };
      if (!continuation)
        this.db
          .query(
            "INSERT INTO a2a_tasks(id,context_id,target_agent_id,requester_principal_id,requester_agent_id,state,a2a_snapshot_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            taskId,
            contextId,
            agentId,
            principalId,
            requester.agent_id,
            state,
            JSON.stringify(task),
            now,
            now,
          );
      else
        this.db
          .query(
            "UPDATE a2a_tasks SET state=?,state_version=state_version+1,a2a_snapshot_json=?,updated_at_ms=? WHERE id=?",
          )
          .run(state, JSON.stringify(task), now, taskId);
      this.db
        .query(
          "INSERT INTO a2a_messages(id,external_message_id,task_id,context_id,sender_principal_id,sender_agent_id,target_agent_id,role,parts_json,metadata_json,canonical_hash,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          messageRowId,
          message.messageId,
          taskId,
          contextId,
          principalId,
          requester.agent_id,
          agentId,
          message.role === a2aAgentRole ? "agent" : "user",
          JSON.stringify(message.parts),
          JSON.stringify(message.metadata ?? {}),
          requestHash,
          now,
        );
      const sequence = continuation?.next_event_sequence ?? 1;
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          sequence,
          continuation ? "message-received" : "task-created",
          principalId,
          JSON.stringify({ messageId: message.messageId, snapshot: task }),
          now,
        );
      this.db
        .query("UPDATE a2a_tasks SET next_event_sequence=? WHERE id=?")
        .run(sequence + 1, taskId);
      const mode = "direct",
        priority = { low: 0, normal: 10, high: 20 }[options.priority ?? "normal"];
      const payload = {
        taskId,
        contextId,
        message: inbound,
        replyExpected: options.replyExpected ?? true,
        traceContext: options.traceContext,
      };
      this.db
        .query(
          "INSERT INTO delivery_intents(id,kind,task_id,message_id,target_agent_id,mode,priority,state,not_before_ms,deadline_ms,payload_json,payload_hash,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          deliveryId,
          "a2a-message",
          taskId,
          messageRowId,
          agentId,
          mode,
          priority,
          DeliveryState.Pending,
          now,
          options.expiresAt ? Date.parse(options.expiresAt) : null,
          JSON.stringify(payload),
          this.payloadHash(payload),
          now,
          now,
        );
      if (requester.binding_id && options.notifyOn?.length) {
        const subscription = this.db
          .query<{ id: string }, [string, string, BindingId]>(
            "SELECT id FROM task_subscriptions WHERE task_id=? AND subscriber_principal_id=? AND origin_binding_id=? AND status='active'",
          )
          .get(taskId, principalId, requester.binding_id);
        if (subscription)
          this.db
            .query("UPDATE task_subscriptions SET event_filter_json=?,updated_at_ms=? WHERE id=?")
            .run(JSON.stringify(options.notifyOn), now, subscription.id);
        else
          this.db
            .query(
              "INSERT INTO task_subscriptions(id,task_id,subscriber_principal_id,subscriber_agent_id,origin_binding_id,origin_binding_epoch,event_filter_json,created_at_ms,updated_at_ms) SELECT ?,?,?,?,?,b.epoch,?,?,? FROM runtime_bindings b WHERE b.id=?",
            )
            .run(
              id("sub"),
              taskId,
              principalId,
              requester.agent_id,
              requester.binding_id,
              JSON.stringify(options.notifyOn),
              now,
              now,
              requester.binding_id,
            );
      }
      const response = {
        task,
        deliveryId,
        stateVersion: continuation ? continuation.state_version + 1 : 1,
      };
      this.db
        .query(
          "INSERT INTO idempotency_records(scope,key,request_hash,state,response_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          scope,
          message.messageId,
          requestHash,
          "committed",
          JSON.stringify(response),
          now,
          now,
        );
      return { ...response, duplicate: false };
    });
  }
  setTaskState(
    taskId: string,
    principalId: string,
    next: TaskState,
    summary = "",
    details: Record<string, unknown> = {},
  ): StoredTask {
    return telemetry.traceSync("task.transition", () =>
      this.transitionTask(taskId, principalId, next, summary, details),
    );
  }
  acknowledgeTask(taskId: string, principalId: string, deliveryId?: string) {
    return this.write(() => {
      const row = this.assignedTask(taskId, principalId);
      if (deliveryId) {
        const observed = this.db
          .query<{ sequence: number }, [string, string]>(
            "SELECT rowid sequence FROM delivery_intents WHERE id=? AND task_id=? AND kind='a2a-message'",
          )
          .get(deliveryId, taskId);
        if (!observed) throw new Error("DELIVERY_NOT_FOUND");
        const deliveries = this.db
          .query<DeliveryIntentRow, [string, number]>(
            "SELECT * FROM delivery_intents WHERE task_id=? AND kind='a2a-message' AND state IN ('pending','deferred','leased','attempting','acceptance-unknown') AND rowid<=?",
          )
          .all(taskId, observed.sequence);
        if (
          deliveries.some(
            (delivery) => ![DeliveryState.Pending, DeliveryState.Deferred].includes(delivery.state),
          )
        )
          throw new Error("DELIVERY_IN_PROGRESS");
        const now = Date.now();
        for (const delivery of deliveries)
          this.db
            .query(
              "UPDATE delivery_intents SET state=?,state_reason='inbox-acknowledged',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
            )
            .run(transitionDelivery(delivery.state, DeliveryState.Canceled), now, delivery.id);
      }
      if (row.state === TaskState.Working) return parseTask(row.a2a_snapshot_json);
      return this.setTaskState(taskId, principalId, TaskState.Working);
    });
  }
  completeTask(taskId: string, principalId: string, summary: string, artifacts: StoredArtifact[]) {
    return this.write(() => {
      const row = this.assignedTask(taskId, principalId),
        task = parseTask(row.a2a_snapshot_json);
      if (row.state === TaskState.Completed) {
        if ((row.summary ?? "") === summary && artifactSuffixMatches(task.artifacts, artifacts))
          return task;
        throw new Error("TASK_STATE_CONFLICT");
      }
      if (terminalTaskState(row.state)) throw new Error("TASK_STATE_CONFLICT");
      if (
        this.db
          .query(
            "SELECT 1 FROM delivery_intents WHERE task_id=? AND kind='a2a-message' AND state IN ('pending','deferred','leased','attempting','acceptance-unknown') LIMIT 1",
          )
          .get(taskId)
      )
        throw new Error("UNACKNOWLEDGED_MESSAGES");
      if (artifacts.length) this.publishArtifacts(taskId, principalId, artifacts);
      return this.setTaskState(taskId, principalId, TaskState.Completed, summary);
    });
  }
  private transitionTask(
    taskId: string,
    principalId: string,
    next: TaskState,
    summary: string,
    details: Record<string, unknown>,
  ): StoredTask {
    return this.write(() => {
      const row = this.db
        .query<TaskRow, [string]>("SELECT * FROM a2a_tasks WHERE id=?")
        .get(taskId);
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.requester_principal_id === principalId) {
        if (next !== TaskState.Canceled) throw new Error("TASK_NOT_ASSIGNED");
      } else {
        this.assignedTask(taskId, principalId);
      }
      const task = parseTask(row.a2a_snapshot_json);
      if (row.state === next && terminalTaskState(next)) {
        const prior = this.db
          .query<{ payload_json: string }, [string, string]>(
            "SELECT payload_json FROM task_events WHERE task_id=? AND event_type=? ORDER BY sequence DESC LIMIT 1",
          )
          .get(taskId, taskEventTypes[next]);
        if (prior && sameTransitionPayload(prior.payload_json, summary, details)) return task;
        throw new Error("TASK_STATE_CONFLICT");
      }
      const state = transition(row.state, next),
        now = Date.now();
      task.status = {
        state: taskStates[state],
        message: summary
          ? {
              messageId: id("msg"),
              contextId: task.contextId,
              taskId,
              role: a2aAgentRole,
              parts: [
                {
                  content: { $case: "text", value: summary },
                  metadata: undefined,
                  filename: "",
                  mediaType: "text/plain",
                },
              ],
              metadata: Object.keys(details).length ? details : undefined,
              extensions: [],
              referenceTaskIds: [],
            }
          : undefined,
        timestamp: new Date(now).toISOString(),
      };
      if (task.status.message) task.history.push(task.status.message);
      this.db
        .query(
          "UPDATE a2a_tasks SET state=?,state_version=state_version+1,summary=?,a2a_snapshot_json=?,updated_at_ms=?,terminal_at_ms=? WHERE id=?",
        )
        .run(
          state,
          summary || null,
          JSON.stringify(task),
          now,
          ["completed", "failed", "canceled", "rejected"].includes(state) ? now : null,
          taskId,
        );
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          row.next_event_sequence,
          taskEventTypes[state],
          principalId,
          JSON.stringify({ summary, ...details, snapshot: task }),
          now,
        );
      this.db
        .query("UPDATE a2a_tasks SET next_event_sequence=next_event_sequence+1 WHERE id=?")
        .run(taskId);
      const subscriptions = this.db
        .query<
          {
            subscriber_agent_id: `agt_${string}`;
            origin_binding_id: BindingId;
            origin_binding_epoch: number;
            event_filter_json: string;
          },
          [string]
        >("SELECT * FROM task_subscriptions WHERE task_id=? AND status='active'")
        .all(taskId);
      telemetry.traceSync("task.notify", () => {
        for (const subscription of subscriptions) {
          const filters = stringArray(subscription.event_filter_json),
            isTerminal = ["completed", "failed", "canceled", "rejected"].includes(state);
          if (!filters.includes(state) && !(isTerminal && filters.includes("terminal"))) continue;
          const payload = {
              taskId,
              contextId: row.context_id,
              state,
              sequence: row.next_event_sequence,
              summary,
            },
            deliveryId = id("int");
          this.db
            .query(
              "INSERT INTO delivery_intents(id,kind,task_id,target_agent_id,pinned_binding_id,pinned_binding_epoch,mode,priority,state,not_before_ms,payload_json,payload_hash,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'direct',10,?,?,?,?,?,?)",
            )
            .run(
              deliveryId,
              "task-event-notification",
              taskId,
              subscription.subscriber_agent_id,
              subscription.origin_binding_id,
              subscription.origin_binding_epoch,
              DeliveryState.Pending,
              now,
              JSON.stringify(payload),
              this.payloadHash(payload),
              now,
              now,
            );
        }
      });
      if (state === TaskState.Canceled) {
        const deliveries = this.db
          .query<DeliveryIntentRow, [string]>(
            "SELECT * FROM delivery_intents WHERE task_id=? AND kind='a2a-message' AND state IN ('pending','deferred','leased')",
          )
          .all(taskId);
        for (const delivery of deliveries)
          this.db
            .query(
              "UPDATE delivery_intents SET state=?,state_reason='task-canceled',updated_at_ms=? WHERE id=?",
            )
            .run(transitionDelivery(delivery.state, DeliveryState.Canceled), now, delivery.id);
      }
      return task;
    });
  }
  requestCancellation(taskId: string, principalId: string, reason = "") {
    return this.write(() => {
      const row = this.db
        .query<TaskRow, [string, string]>(
          "SELECT * FROM a2a_tasks WHERE id=? AND requester_principal_id=?",
        )
        .get(taskId, principalId);
      if (!row) throw new Error("ACS_TASK_NOT_VISIBLE");
      if (
        [TaskState.Completed, TaskState.Failed, TaskState.Canceled, TaskState.Rejected].includes(
          row.state,
        )
      ) {
        if (row.state === TaskState.Canceled)
          return this.setTaskState(taskId, principalId, TaskState.Canceled, reason);
        throw new Error("TASK_STATE_CONFLICT");
      }
      if (row.cancellation_requested) return parseTask(row.a2a_snapshot_json);
      const unresolved = this.db
        .query(
          "SELECT 1 FROM delivery_intents i LEFT JOIN runtime_executions e ON e.intent_id=i.id AND e.state IN ('accepted','started','awaiting-local-input') WHERE i.task_id=? AND (i.state IN ('attempting','acceptance-unknown') OR e.id IS NOT NULL) LIMIT 1",
        )
        .get(taskId);
      if (!unresolved) return this.setTaskState(taskId, principalId, TaskState.Canceled, reason);
      const now = Date.now(),
        task = parseTask(row.a2a_snapshot_json);
      task.metadata = {
        ...task.metadata,
        "urn:agent-communications:cancellation:v1": { requested: true, reason },
      };
      this.db
        .query(
          "UPDATE a2a_tasks SET cancellation_requested=1,a2a_snapshot_json=?,updated_at_ms=? WHERE id=?",
        )
        .run(JSON.stringify(task), now, taskId);
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          row.next_event_sequence,
          "cancellation-requested",
          principalId,
          JSON.stringify({ reason, snapshot: task }),
          now,
        );
      this.db
        .query("UPDATE a2a_tasks SET next_event_sequence=next_event_sequence+1 WHERE id=?")
        .run(taskId);
      return task;
    });
  }
  publishMessage(taskId: string, principalId: string, parts: StoredPart[], summary = "") {
    if (!parts.length) throw new Error("VALIDATION_FAILED: message parts required");
    return this.write(() => {
      let row = this.assignedTask(taskId, principalId);
      if (row.state === TaskState.Submitted) {
        this.setTaskState(taskId, principalId, TaskState.Working);
        row = this.assignedTask(taskId, principalId);
      }
      if (["completed", "failed", "canceled", "rejected"].includes(row.state))
        throw new Error("TASK_STATE_CONFLICT");
      const now = Date.now(),
        message: StoredMessage = {
          messageId: id("msg"),
          contextId: row.context_id,
          taskId,
          role: a2aAgentRole,
          parts,
          metadata: summary ? { summary } : undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        task = parseTask(row.a2a_snapshot_json);
      task.history.push(message);
      this.db
        .query(
          "INSERT INTO a2a_messages(id,external_message_id,task_id,context_id,sender_principal_id,sender_agent_id,target_agent_id,role,parts_json,metadata_json,canonical_hash,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id("msg"),
          message.messageId,
          taskId,
          row.context_id,
          principalId,
          row.target_agent_id,
          row.target_agent_id,
          "agent",
          JSON.stringify(parts),
          JSON.stringify(message.metadata ?? {}),
          this.payloadHash(message),
          now,
        );
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          row.next_event_sequence,
          "message-published",
          principalId,
          JSON.stringify({ messageId: message.messageId, snapshot: task }),
          now,
        );
      this.db
        .query(
          "UPDATE a2a_tasks SET a2a_snapshot_json=?,next_event_sequence=next_event_sequence+1,updated_at_ms=? WHERE id=?",
        )
        .run(JSON.stringify(task), now, taskId);
      return { task, eventSequence: row.next_event_sequence };
    });
  }
  publishArtifacts(taskId: string, principalId: string, artifacts: StoredArtifact[]) {
    if (!artifacts.length) throw new Error("VALIDATION_FAILED: artifacts required");
    return this.write(() => {
      const row = this.assignedTask(taskId, principalId);
      if (["completed", "failed", "canceled", "rejected"].includes(row.state))
        throw new Error("TASK_STATE_CONFLICT");
      const now = Date.now(),
        task = parseTask(row.a2a_snapshot_json);
      task.artifacts.push(...artifacts);
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          row.next_event_sequence,
          "artifact-published",
          principalId,
          JSON.stringify({
            artifactIds: artifacts.map((artifact) => artifact.artifactId),
            snapshot: task,
          }),
          now,
        );
      this.db
        .query(
          "UPDATE a2a_tasks SET a2a_snapshot_json=?,next_event_sequence=next_event_sequence+1,updated_at_ms=? WHERE id=?",
        )
        .run(JSON.stringify(task), now, taskId);
      return { task, eventSequence: row.next_event_sequence };
    });
  }
  retryDelivery(deliveryId: string) {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (delivery.state !== DeliveryState.Deferred) throw new Error("TASK_STATE_CONFLICT");
    const pending = transitionDelivery(delivery.state, DeliveryState.Pending);
    this.db
      .query(
        "UPDATE delivery_intents SET state=?,state_reason=NULL,not_before_ms=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(pending, Date.now(), Date.now(), deliveryId);
    return this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
  }
  cancelDelivery(deliveryId: string, reason = "operator-canceled") {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    const canceled = transitionDelivery(delivery.state, DeliveryState.Canceled);
    this.db
      .query(
        "UPDATE delivery_intents SET state=?,state_reason=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(canceled, reason, Date.now(), deliveryId);
    return this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
  }
  resolveUnknown(deliveryId: string, resolution: string) {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (delivery.state !== DeliveryState.AcceptanceUnknown) throw new Error("ACCEPTANCE_UNKNOWN");
    const requestedState =
      resolution === "accepted"
        ? DeliveryState.Accepted
        : resolution === "not-accepted-and-retry"
          ? DeliveryState.Pending
          : resolution === "not-accepted-and-cancel"
            ? DeliveryState.Canceled
            : null;
    if (!requestedState) throw new Error("VALIDATION_FAILED");
    const state = transitionDelivery(DeliveryState.AcceptanceUnknown, requestedState);
    this.db
      .query(
        "UPDATE delivery_intents SET state=?,state_reason='operator-resolution',not_before_ms=?,updated_at_ms=? WHERE id=?",
      )
      .run(state, Date.now(), Date.now(), deliveryId);
    return this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
  }
  private assignedTask(taskId: string, principalId: string) {
    const row = this.db
      .query<TaskRow, [string, string]>(
        "SELECT t.* FROM a2a_tasks t JOIN principals p ON p.id=? AND p.agent_id=t.target_agent_id JOIN runtime_bindings b ON b.id=p.binding_id AND b.status='active' WHERE t.id=? AND p.disabled_at_ms IS NULL AND (NOT EXISTS (SELECT 1 FROM delivery_intents i WHERE i.task_id=t.id AND i.pinned_binding_id IS NOT NULL) OR EXISTS (SELECT 1 FROM delivery_intents i WHERE i.task_id=t.id AND i.pinned_binding_id=b.id AND i.pinned_binding_epoch=b.epoch))",
      )
      .get(principalId, taskId);
    if (!row) throw new Error("TASK_NOT_ASSIGNED");
    return row;
  }
}

function stringArray(json: string) {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("STORAGE_CORRUPT: expected string array");
  return value;
}
function must<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}
function terminalTaskState(state: TaskState) {
  return [TaskState.Completed, TaskState.Failed, TaskState.Canceled, TaskState.Rejected].includes(
    state,
  );
}
function sameTransitionPayload(json: string, summary: string, details: Record<string, unknown>) {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.summary !== summary) return false;
  const priorDetails: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    if (key !== "summary" && key !== "snapshot") priorDetails[key] = item;
  return canonical(priorDetails) === canonical(details);
}
function artifactSuffixMatches(existing: StoredArtifact[], expected: StoredArtifact[]) {
  if (!expected.length) return true;
  return (
    canonical(existing.slice(-expected.length).map(artifactPayload)) ===
    canonical(expected.map(artifactPayload))
  );
}
function artifactPayload(artifact: StoredArtifact) {
  return {
    name: artifact.name,
    description: artifact.description,
    parts: artifact.parts,
    metadata: artifact.metadata,
    extensions: artifact.extensions,
  };
}

function bindingClaimCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`),
    result = "";
  for (let index = 0; index < 26; index++) {
    result = must(alphabet.at(Number(value & 31n)), "claim alphabet") + result;
    value >>= 5n;
  }
  return result;
}

function parseTask(json: string): StoredTask {
  const result = storedTaskSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error("STORAGE_CORRUPT: invalid task snapshot");
  return result.data;
}
function taskState(task: StoredTask): TaskState {
  switch (task.status?.state) {
    case 1:
      return TaskState.Submitted;
    case 2:
      return TaskState.Working;
    case 3:
      return TaskState.Completed;
    case 4:
      return TaskState.Failed;
    case 5:
      return TaskState.Canceled;
    case 6:
      return TaskState.InputRequired;
    case 7:
      return TaskState.Rejected;
    case 8:
      return TaskState.AuthRequired;
    default:
      throw new Error("STORAGE_CORRUPT: invalid task state");
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pageCursor(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.sortKey !== "number" ||
    !Number.isSafeInteger(value.sortKey) ||
    typeof value.id !== "string"
  )
    throw new Error("VALIDATION_FAILED: invalid cursor");
  return { sortKey: value.sortKey, id: value.id };
}

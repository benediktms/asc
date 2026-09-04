import { Database } from "bun:sqlite";
import migration from "../../../storage/001_initial.sql" with { type: "text" };
import { agentSlug, canonical, id, TaskState, transition } from "../../domain/src/index";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BindingId,
  DeliveryId,
  JsonValue,
  RuntimeInstallationId,
} from "../../../contracts/runtime-adapter";
import { loadConfig } from "../../config/src/index";
import { z } from "zod";
export interface StoredPart {
  content?:
    | { $case: "text"; value: string }
    | { $case: "url"; value: string }
    | { $case: "data"; value: JsonValue }
    | { $case: "raw"; value: unknown };
  metadata?: Record<string, unknown>;
  filename: string;
  mediaType: string;
}
export interface StoredMessage {
  messageId: string;
  contextId: string;
  taskId: string;
  role: number;
  parts: StoredPart[];
  metadata?: Record<string, unknown>;
  extensions: string[];
  referenceTaskIds: string[];
}
export interface StoredTask {
  id: string;
  contextId: string;
  status?: { state: number; message?: StoredMessage; timestamp: string };
  artifacts: StoredArtifact[];
  history: StoredMessage[];
  metadata?: Record<string, unknown>;
}
export interface StoredArtifact {
  artifactId: string;
  name: string;
  description: string;
  parts: StoredPart[];
  metadata?: Record<string, unknown>;
  extensions: string[];
}

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

export interface AgentRow {
  id: `agt_${string}`;
  slug: string;
  display_name: string;
  description: string;
  skills_json: string;
  enabled: number;
  profile_revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
}
export interface BindingRow {
  id: BindingId;
  agent_id: `agt_${string}`;
  installation_id: RuntimeInstallationId;
  session_opaque_id: string;
  epoch: number;
  status: "pending" | "active" | "stale" | "revoked";
  continuity_policy: "follow-pending" | "strict";
  delivery_policy_json: string;
  created_at_ms: number;
  activated_at_ms: number | null;
  revoked_at_ms: number | null;
  last_observed_availability: string | null;
}
export interface DeliveryIntentRow {
  id: DeliveryId;
  kind: "a2a-message" | "task-event-notification";
  task_id: `tsk_${string}`;
  target_agent_id: `agt_${string}`;
  mode: "wake_when_idle" | "append_context" | "join_active";
  state: string;
  attempt_count: number;
  payload_json: string;
  payload_hash: string;
  deadline_ms: number | null;
  pinned_binding_id: BindingId | null;
  pinned_binding_epoch: number | null;
}
interface TaskRow {
  id: `tsk_${string}`;
  context_id: `ctx_${string}`;
  target_agent_id: `agt_${string}`;
  requester_principal_id: `prn_${string}`;
  requester_agent_id: `agt_${string}` | null;
  state: TaskState;
  next_event_sequence: number;
  a2a_snapshot_json: string;
}
interface DeliveryOptions {
  mode?: "wake_when_idle" | "append_context";
  priority?: "low" | "normal" | "high";
  notifyOn?: string[];
  replyExpected?: boolean;
  expiresAt?: string;
}

export interface Paths {
  data: string;
  runtime: string;
  token: string;
  bridgeToken: string;
  secret: string;
}
export function paths(): Paths {
  const base = process.env.ACS_HOME ?? `${process.env.HOME}/Library/Application Support/acs`,
    config = loadConfig();
  return {
    data:
      process.env.ACS_STORAGE_PATH ??
      (process.env.ACS_HOME ? `${base}/acs.db` : config.storage.path),
    runtime:
      process.env.ACS_CONTROL_SOCKET ??
      (process.env.ACS_HOME
        ? `${process.env.TMPDIR ?? "/tmp"}/acs-${process.getuid?.() ?? 0}/control.sock`
        : config.daemon.controlSocket),
    token: `${base}/control.token`,
    bridgeToken: `${base}/bridge.token`,
    secret: `${base}/secret.key`,
  };
}

export function initFiles(target = paths()): string {
  mkdirSync(dirname(target.data), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(target.runtime), { recursive: true, mode: 0o700 });
  if (!Bun.file(target.secret).size) {
    writeFileSync(target.secret, randomBytes(32));
    chmodSync(target.secret, 0o600);
  }
  if (!Bun.file(target.token).size) {
    writeFileSync(target.token, randomBytes(32).toString("base64url"));
    chmodSync(target.token, 0o600);
  }
  if (!Bun.file(target.bridgeToken).size) {
    writeFileSync(target.bridgeToken, randomBytes(32).toString("base64url"));
    chmodSync(target.bridgeToken, 0o600);
  }
  return readFileSync(target.token, "utf8");
}

export class Store {
  readonly db: Database;
  readonly secret: Buffer;
  readonly limits: {
    maxInlineContentBytes: number;
    claimTtlSeconds: number;
    defaultMode: "wake_when_idle" | "append_context";
    busyTimeoutMs: number;
    durability: "balanced" | "strict";
  };
  constructor(
    readonly config = paths(),
    limits: Partial<Store["limits"]> = {},
  ) {
    this.limits = {
      maxInlineContentBytes: 262144,
      claimTtlSeconds: 600,
      defaultMode: "wake_when_idle",
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
  cursorOffset(cursor?: string) {
    if (!cursor) return 0;
    const decoded = this.decodeCursor(cursor),
      value = isRecord(decoded) ? decoded.offset : undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("VALIDATION_FAILED: invalid cursor");
    return value;
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
    this.db.transaction(() => {
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
    })();
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
    this.db.transaction(() => {
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
    })();
    this.audit(principalId, "token.issue", "token", tokenId, { kind });
    return { token, principalId };
  }
  createAgent(slugValue: string, displayName?: string, description = "") {
    const slug = agentSlug(slugValue),
      agentId = id("agt"),
      now = Date.now();
    this.db
      .query(
        "INSERT INTO agents(id,slug,display_name,description,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)",
      )
      .run(agentId, slug, displayName ?? slug, description, now, now);
    return this.agent(slug)!;
  }
  updateAgent(
    value: string,
    patch: { displayName?: string; description?: string; enabled?: boolean; skills?: unknown[] },
  ) {
    const agent = this.agent(value);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    this.db
      .query(
        "UPDATE agents SET display_name=?,description=?,enabled=?,skills_json=?,profile_revision=profile_revision+1,updated_at_ms=? WHERE id=?",
      )
      .run(
        patch.displayName ?? agent.display_name,
        patch.description ?? agent.description,
        patch.enabled === undefined ? agent.enabled : Number(patch.enabled),
        JSON.stringify(patch.skills ?? JSON.parse(agent.skills_json)),
        Date.now(),
        agent.id,
      );
    return this.agent(agent.id)!;
  }
  deleteAgent(value: string) {
    const agent = this.agent(value);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query("UPDATE agents SET enabled=0,deleted_at_ms=?,updated_at_ms=? WHERE id=?")
        .run(now, now, agent.id);
      this.db
        .query(
          "UPDATE runtime_bindings SET status='revoked',revoked_at_ms=?,revocation_reason='agent-deleted' WHERE agent_id=? AND status='active'",
        )
        .run(now, agent.id);
    })();
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
  bind(agentValue: string, sessionId: string, allowNonAtomicWake = false) {
    const agent = this.agent(agentValue);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const installation = this.db
      .query<{ id: RuntimeInstallationId }, []>(
        "SELECT id FROM runtime_installations WHERE harness_id='codex' LIMIT 1",
      )
      .get()!;
    const now = Date.now(),
      bindingId = id("bnd"),
      epoch =
        (this.db
          .query<{ value: number | null }, [`agt_${string}`]>(
            "SELECT max(epoch) value FROM runtime_bindings WHERE agent_id=?",
          )
          .get(agent.id)!.value ?? 0) + 1;
    return this.db.transaction(() => {
      this.db
        .query(
          "UPDATE runtime_bindings SET status='revoked',revoked_at_ms=?,revocation_reason='rebound' WHERE agent_id=? AND status='active'",
        )
        .run(now, agent.id);
      this.db
        .query(
          "INSERT INTO runtime_bindings(id,agent_id,installation_id,session_opaque_id,epoch,status,continuity_policy,delivery_policy_json,created_at_ms,activated_at_ms) VALUES(?,?,?,?,?,'active','follow-pending',?,?,?)",
        )
        .run(
          bindingId,
          agent.id,
          installation.id,
          sessionId,
          epoch,
          JSON.stringify({
            wakeStrategy: allowNonAtomicWake ? "non-atomic-idle-check" : "atomic-only",
            allowActiveTurnSteering: false,
            autoResumeDormantThread: false,
            interruptOnCancel: true,
          }),
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
      return { id: bindingId, agentId: agent.id, sessionId, epoch, principalId };
    })();
  }
  binding(bindingId: string) {
    return this.db
      .query<BindingRow, [string]>("SELECT * FROM runtime_bindings WHERE id=?")
      .get(bindingId);
  }
  revokeBinding(bindingId: string, reason = "revoked") {
    const binding = this.binding(bindingId);
    if (!binding) throw new Error("BINDING_NOT_FOUND");
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE runtime_bindings SET status='revoked',revoked_at_ms=?,revocation_reason=? WHERE id=?",
        )
        .run(now, reason, bindingId);
      this.db
        .query(
          "UPDATE principals SET disabled_at_ms=? WHERE binding_id=? AND disabled_at_ms IS NULL",
        )
        .run(now, bindingId);
    })();
    return this.binding(bindingId);
  }
  createClaim(agentValue: string, principalId: string, ttlSeconds = this.limits.claimTtlSeconds) {
    const agent = this.agent(agentValue);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const claimCode = randomBytes(24).toString("base64url"),
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
  claim(code: string, sessionId: string) {
    const row = this.db
      .query<{ id: `clm_${string}`; agent_id: `agt_${string}` }, [Buffer, number]>(
        "SELECT * FROM binding_claims WHERE code_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>?",
      )
      .get(this.hashToken(code), Date.now());
    if (!row) throw new Error("VALIDATION_FAILED: invalid or expired claim");
    return this.db.transaction(() => {
      const binding = this.bind(row.agent_id, sessionId);
      this.db
        .query(
          "UPDATE binding_claims SET consumed_at_ms=?,consumed_by_binding_id=? WHERE id=? AND consumed_at_ms IS NULL",
        )
        .run(Date.now(), binding.id, row.id);
      return binding;
    })();
  }
  attest(threadId: unknown) {
    if (typeof threadId !== "string" || !threadId || threadId.length > 512)
      return { kind: "unattested", reason: "missing-session-id" } as const;
    const row = this.db
      .query<
        {
          binding_id: BindingId;
          epoch: number;
          agent_id: `agt_${string}`;
          principal_id: `prn_${string}`;
          slug: string;
          display_name: string;
        },
        [string]
      >(
        "SELECT b.id binding_id,b.epoch,b.agent_id,p.id principal_id,a.slug,a.display_name FROM runtime_bindings b JOIN principals p ON p.binding_id=b.id JOIN agents a ON a.id=b.agent_id WHERE b.session_opaque_id=? AND b.status='active' AND p.disabled_at_ms IS NULL",
      )
      .get(threadId);
    return row
      ? ({
          kind: "attested",
          scheme: "codex-mcp-thread-meta-v1",
          bindingId: row.binding_id,
          bindingEpoch: row.epoch,
          agentId: row.agent_id,
          principalId: row.principal_id,
          slug: row.slug,
          displayName: row.display_name,
        } as const)
      : ({ kind: "unattested", reason: "unbound-session" } as const);
  }
  issueToken(principalId: string, ttlSeconds = 300) {
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
        '["a2a:send","a2a:read","a2a:cancel"]',
        now,
        now + ttlSeconds * 1000,
      );
    this.audit(principalId, "token.issue", "token", undefined, { ttlSeconds });
    return token;
  }
  inbox(agentId: string) {
    return this.db
      .query<{ a2a_snapshot_json: string }, [string]>(
        "SELECT a2a_snapshot_json FROM a2a_tasks WHERE target_agent_id=? AND state NOT IN ('completed','failed','canceled','rejected') ORDER BY updated_at_ms DESC LIMIT 100",
      )
      .all(agentId)
      .map((row) => JSON.parse(row.a2a_snapshot_json));
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
    const row = this.db
      .query<TaskRow, [string, string, string | null, string | null, string]>(
        "SELECT t.* FROM a2a_tasks t LEFT JOIN principals p ON p.id=? WHERE t.id=? AND (? IS NULL OR t.target_agent_id=?) AND (t.requester_principal_id=? OR p.agent_id=t.target_agent_id)",
      )
      .get(principalId, idValue, targetAgentId ?? null, targetAgentId ?? null, principalId);
    return row ? JSON.parse(row.a2a_snapshot_json) : undefined;
  }
  listTasks(agentId: string, principalId: string): StoredTask[] {
    return this.db
      .query<{ a2a_snapshot_json: string }, [string, string]>(
        "SELECT a2a_snapshot_json FROM a2a_tasks WHERE target_agent_id=? AND requester_principal_id=? ORDER BY updated_at_ms DESC LIMIT 100",
      )
      .all(agentId, principalId)
      .map((row) => JSON.parse(row.a2a_snapshot_json));
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
      .query<{ sequence: number; event_type: string; payload_json: string }, [string, number]>(
        "SELECT sequence,event_type,payload_json FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence",
      )
      .all(taskId, sequence);
  }
  accept(
    agentId: string,
    principalId: string,
    message: StoredMessage,
    options: DeliveryOptions,
  ): { task: StoredTask; deliveryId: string; duplicate: boolean } {
    if (!message.messageId || !message.parts.length)
      throw new Error("VALIDATION_FAILED: messageId and parts are required");
    if (message.parts.length > 32) throw new Error("ACS_MESSAGE_TOO_LARGE");
    let bytes = 0;
    for (const part of message.parts) {
      if (!part.content || part.content.$case === "raw") throw new Error("ACS_UNSUPPORTED_CONTENT");
      if (part.content.$case === "text" && Buffer.byteLength(part.content.value) > 65536)
        throw new Error("ACS_MESSAGE_TOO_LARGE");
      bytes += Buffer.byteLength(JSON.stringify(part));
    }
    if (bytes > this.limits.maxInlineContentBytes) throw new Error("ACS_MESSAGE_TOO_LARGE");
    const scope = `${principalId}:${agentId}`,
      requestHash = this.payloadHash({ message, options });
    const existing = this.db
      .query<{ request_hash: string; response_json: string }, [string, string]>(
        "SELECT request_hash,response_json FROM idempotency_records WHERE scope=? AND key=?",
      )
      .get(scope, message.messageId);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error("ACS_IDEMPOTENCY_CONFLICT");
      return { ...JSON.parse(existing.response_json), duplicate: true };
    }
    const result = this.db.transaction(() => {
      const now = Date.now(),
        contextId = message.contextId || id("ctx"),
        taskId = message.taskId || id("tsk"),
        messageRowId = id("msg"),
        deliveryId = id("int");
      const requester = this.db
        .query<{ agent_id: `agt_${string}` | null; binding_id: BindingId | null }, [string]>(
          "SELECT agent_id,binding_id FROM principals WHERE id=?",
        )
        .get(principalId)!;
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
      const inbound: StoredMessage = { ...message, contextId, taskId, role: 1 };
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
          "user",
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
          JSON.stringify({ messageId: message.messageId }),
          now,
        );
      this.db
        .query("UPDATE a2a_tasks SET next_event_sequence=? WHERE id=?")
        .run(sequence + 1, taskId);
      const mode = options.mode ?? this.limits.defaultMode,
        priority = { low: 0, normal: 10, high: 20 }[options.priority ?? "normal"];
      const payload = {
        taskId,
        contextId,
        message: inbound,
        replyExpected: options.replyExpected ?? true,
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
          "pending",
          now,
          options.expiresAt ? Date.parse(options.expiresAt) : null,
          JSON.stringify(payload),
          this.payloadHash(payload),
          now,
          now,
        );
      if (requester.binding_id && options.notifyOn?.length)
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
      const response = { task, deliveryId };
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
    return result();
  }
  setTaskState(
    taskId: string,
    principalId: string,
    next: TaskState,
    summary = "",
    details: Record<string, unknown> = {},
  ): StoredTask {
    return this.db.transaction(() => {
      const row = this.db
        .query<TaskRow, [string]>("SELECT * FROM a2a_tasks WHERE id=?")
        .get(taskId);
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.requester_principal_id === principalId) {
        if (next !== TaskState.Canceled) throw new Error("TASK_NOT_ASSIGNED");
      } else {
        this.assignedTask(taskId, principalId);
      }
      const state = transition(row.state, next),
        now = Date.now(),
        task = parseTask(row.a2a_snapshot_json);
      task.status = {
        state: taskStates[state],
        message: summary
          ? {
              messageId: id("msg"),
              contextId: task.contextId,
              taskId,
              role: 2,
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
      const eventType: Record<TaskState, string> = {
        submitted: "task-created",
        working: "task-working",
        "input-required": "input-required",
        "auth-required": "input-required",
        completed: "task-completed",
        failed: "task-failed",
        canceled: "task-canceled",
        rejected: "task-rejected",
      };
      this.db
        .query(
          "INSERT INTO task_events(id,task_id,sequence,event_type,actor_principal_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id("evt"),
          taskId,
          row.next_event_sequence,
          eventType[state],
          principalId,
          JSON.stringify({ summary, ...details }),
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
            "INSERT INTO delivery_intents(id,kind,task_id,target_agent_id,pinned_binding_id,pinned_binding_epoch,mode,priority,state,not_before_ms,payload_json,payload_hash,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'append_context',10,'pending',?,?,?,?,?)",
          )
          .run(
            deliveryId,
            "task-event-notification",
            taskId,
            subscription.subscriber_agent_id,
            subscription.origin_binding_id,
            subscription.origin_binding_epoch,
            now,
            JSON.stringify(payload),
            this.payloadHash(payload),
            now,
            now,
          );
      }
      if (state === TaskState.Canceled)
        this.db
          .query(
            "UPDATE delivery_intents SET state='canceled',state_reason='task-canceled',updated_at_ms=? WHERE task_id=? AND kind='a2a-message' AND state IN ('pending','deferred','leased')",
          )
          .run(now, taskId);
      return task;
    })();
  }
  requestCancellation(taskId: string, principalId: string, reason = "") {
    return this.db.transaction(() => {
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
      )
        throw new Error("TASK_STATE_CONFLICT");
      const execution = this.db
        .query(
          "SELECT 1 FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id WHERE i.task_id=? AND e.state IN ('accepted','started','awaiting-local-input') LIMIT 1",
        )
        .get(taskId);
      if (!execution) return this.setTaskState(taskId, principalId, TaskState.Canceled, reason);
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
          JSON.stringify({ reason }),
          now,
        );
      this.db
        .query("UPDATE a2a_tasks SET next_event_sequence=next_event_sequence+1 WHERE id=?")
        .run(taskId);
      return task;
    })();
  }
  publishMessage(taskId: string, principalId: string, parts: StoredPart[], summary = "") {
    if (!parts.length) throw new Error("VALIDATION_FAILED: message parts required");
    return this.db.transaction(() => {
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
          role: 2,
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
          JSON.stringify({ messageId: message.messageId }),
          now,
        );
      this.db
        .query(
          "UPDATE a2a_tasks SET a2a_snapshot_json=?,next_event_sequence=next_event_sequence+1,updated_at_ms=? WHERE id=?",
        )
        .run(JSON.stringify(task), now, taskId);
      return { task, eventSequence: row.next_event_sequence };
    })();
  }
  publishArtifacts(taskId: string, principalId: string, artifacts: StoredArtifact[]) {
    if (!artifacts.length) throw new Error("VALIDATION_FAILED: artifacts required");
    return this.db.transaction(() => {
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
          JSON.stringify({ artifactIds: artifacts.map((artifact) => artifact.artifactId) }),
          now,
        );
      this.db
        .query(
          "UPDATE a2a_tasks SET a2a_snapshot_json=?,next_event_sequence=next_event_sequence+1,updated_at_ms=? WHERE id=?",
        )
        .run(JSON.stringify(task), now, taskId);
      return { task, eventSequence: row.next_event_sequence };
    })();
  }
  retryDelivery(deliveryId: string) {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (!["deferred", "failed-terminal"].includes(delivery.state))
      throw new Error("TASK_STATE_CONFLICT");
    this.db
      .query(
        "UPDATE delivery_intents SET state='pending',state_reason=NULL,not_before_ms=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(Date.now(), Date.now(), deliveryId);
    return this.db.query("SELECT * FROM delivery_intents WHERE id=?").get(deliveryId);
  }
  cancelDelivery(deliveryId: string, reason = "operator-canceled") {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>("SELECT * FROM delivery_intents WHERE id=?")
      .get(deliveryId);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (["accepted", "canceled", "superseded"].includes(delivery.state))
      throw new Error("TASK_STATE_CONFLICT");
    this.db
      .query(
        "UPDATE delivery_intents SET state='canceled',state_reason=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(reason, Date.now(), deliveryId);
    return this.db.query("SELECT * FROM delivery_intents WHERE id=?").get(deliveryId);
  }
  resolveUnknown(deliveryId: string, resolution: string) {
    const delivery = this.db
      .query<DeliveryIntentRow, [string]>(
        "SELECT * FROM delivery_intents WHERE id=? AND state='acceptance-unknown'",
      )
      .get(deliveryId);
    if (!delivery) throw new Error("ACCEPTANCE_UNKNOWN");
    const state =
      resolution === "accepted"
        ? "accepted"
        : resolution === "not-accepted-and-retry"
          ? "pending"
          : resolution === "not-accepted-and-cancel"
            ? "canceled"
            : null;
    if (!state) throw new Error("VALIDATION_FAILED");
    this.db
      .query(
        "UPDATE delivery_intents SET state=?,state_reason='operator-resolution',not_before_ms=?,updated_at_ms=? WHERE id=?",
      )
      .run(state, Date.now(), Date.now(), deliveryId);
    return this.db.query("SELECT * FROM delivery_intents WHERE id=?").get(deliveryId);
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

function parseTask(json: string): StoredTask {
  const result = storedTaskSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error("STORAGE_CORRUPT: invalid task snapshot");
  return result.data;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

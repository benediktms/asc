import { id, TaskState } from "../../domain/src/index";
import type {
  BindingRow,
  DeliveryIntentRow,
  StoredMessage,
  StoredPart,
  Store,
} from "../../storage-sqlite/src/index";
import type {
  BindingId,
  DeliveryId,
  RuntimeAdapter,
  RuntimeAdapterContext,
  RuntimeDeliveryEnvelopeV1,
  RuntimeDeliveryRequest,
  RuntimeEvent,
  RuntimeInstallationId,
  RuntimeExecutionId,
  NeutralPart,
} from "../../../contracts/runtime-adapter";
import { telemetry } from "../../observability/src/index";

type DeliveryPayload =
  | { taskId: string; contextId: string; message: StoredMessage; replyExpected: boolean }
  | { taskId: string; contextId: string; state: string; sequence: number; summary: string };
type PartiesRow = {
  display_name: string;
  requester_agent_id: string | null;
  requester_slug: string | null;
  target_agent_id: string;
  target_slug: string;
};
type ExecutionRow = {
  id: RuntimeExecutionId;
  task_id: `tsk_${string}`;
  binding_id: BindingId;
};
type ReconciliationRow = {
  id: DeliveryId;
  payload_hash: string;
  pinned_binding_id: BindingId;
  pinned_binding_epoch: number;
  installation_id: RuntimeInstallationId;
  session_opaque_id: string;
  reconciliation_token: string;
};

export class DeliveryScheduler {
  private timer?: Timer;
  private scheduling = false;
  private abort = new AbortController();
  private observeTask?: Promise<void>;
  private lanes = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private context?: RuntimeAdapterContext;
  private connected = false;
  private nextConnectAt = 0;
  private reconnectAttempts = 0;
  constructor(
    private store: Store,
    private adapter: RuntimeAdapter,
    private instanceId: string,
    private options = {
      concurrency: 16,
      leaseMs: 30_000,
      retryBaseMs: 250,
      retryCapMs: 30_000,
      reconnectMs: 2000,
    },
  ) {}

  async start() {
    const installation = required(
      this.store.db
        .query<{ id: RuntimeInstallationId }, []>(
          "SELECT id FROM runtime_installations WHERE adapter_id='codex.app-server' LIMIT 1",
        )
        .get(),
      "runtime installation",
    );
    this.context = {
      installationId: installation.id,
      instanceId: this.instanceId,
      clock: { now: () => new Date().toISOString() },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      assertBindingFence: async (bindingId, epoch) => {
        const valid = Boolean(
          this.store.db
            .query("SELECT 1 FROM runtime_bindings WHERE id=? AND epoch=? AND status='active'")
            .get(bindingId, epoch),
        );
        return valid ? { valid: true } : { valid: false, reason: "stale" };
      },
    };
    this.recoverExpiredLeases();
    await this.connect();
    this.timer = setInterval(() => void this.tick(), 250);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await Promise.allSettled(this.inFlight);
    if (this.connected) await this.adapter.stop({ reason: "shutdown" });
    await this.observeTask;
  }
  private async tick() {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      if (!this.connected) {
        if (Date.now() >= this.nextConnectAt) await this.connect();
        return;
      }
      if (await this.reconcileOne()) return;
      if (await this.cancelOne()) return;
      while (this.inFlight.size < this.options.concurrency) {
        const intent = this.lease();
        if (!intent) break;
        this.lanes.add(intent.target_agent_id);
        const work = this.deliver(intent)
          .catch((error: unknown) => {
            this.defer(
              intent.id,
              error instanceof Error
                ? (error.message.split(":").at(0) ?? "delivery-error")
                : "delivery-error",
              retryDelay(
                intent.attempt_count + 1,
                Math.random,
                this.options.retryBaseMs,
                this.options.retryCapMs,
              ),
            );
          })
          .finally(() => {
            this.lanes.delete(intent.target_agent_id);
            this.inFlight.delete(work);
          });
        this.inFlight.add(work);
        void work;
      }
    } finally {
      this.scheduling = false;
    }
  }
  private async reconcileOne() {
    const now = Date.now(),
      row = this.store.db
        .query<ReconciliationRow, [number]>(
          "SELECT i.id,i.payload_hash,i.pinned_binding_id,i.pinned_binding_epoch,b.installation_id,b.session_opaque_id,a.reconciliation_token FROM delivery_intents i JOIN runtime_bindings b ON b.id=i.pinned_binding_id JOIN delivery_attempts a ON a.intent_id=i.id AND a.attempt_number=i.attempt_count WHERE i.state='acceptance-unknown' AND i.not_before_ms<=? AND a.reconciliation_token IS NOT NULL LIMIT 1",
        )
        .get(now);
    if (!row) return false;
    const result = await this.adapter.reconcile({
      deliveryId: row.id,
      target: {
        session: {
          installationId: row.installation_id,
          opaqueId: row.session_opaque_id,
        },
        bindingId: row.pinned_binding_id,
        bindingEpoch: row.pinned_binding_epoch,
      },
      payloadHash: row.payload_hash,
      reconciliationToken: row.reconciliation_token,
    });
    if (result.outcome === "accepted") {
      this.store.write(() => {
        this.store.db
          .query(
            "UPDATE delivery_intents SET state='accepted',state_reason=NULL,runtime_execution_id=?,updated_at_ms=? WHERE id=? AND state='acceptance-unknown'",
          )
          .run(result.execution?.opaqueId ?? null, now, row.id);
        if (result.execution)
          this.store.db
            .query(
              "INSERT OR IGNORE INTO runtime_executions(id,intent_id,binding_id,binding_epoch,runtime_execution_opaque_id,state,accepted_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'accepted',?,?)",
            )
            .run(
              id("exe"),
              row.id,
              row.pinned_binding_id,
              row.pinned_binding_epoch,
              result.execution.opaqueId,
              now,
              now,
            );
      });
    } else if (result.outcome === "not-accepted") {
      this.store.db
        .query(
          "UPDATE delivery_intents SET state=?,state_reason=?,not_before_ms=?,updated_at_ms=? WHERE id=? AND state='acceptance-unknown'",
        )
        .run(
          result.safeToRetry ? "pending" : "failed-terminal",
          result.safeToRetry ? null : "reconciliation-not-accepted",
          now,
          now,
          row.id,
        );
    } else {
      this.store.db
        .query(
          "UPDATE delivery_intents SET state_reason=?,not_before_ms=?,updated_at_ms=? WHERE id=? AND state='acceptance-unknown'",
        )
        .run(result.reason, now + 30_000, now, row.id);
    }
    return true;
  }
  private async connect() {
    try {
      await this.adapter.start(required(this.context, "adapter context"));
      this.store.observeRuntime(
        required(this.context, "adapter context").installationId,
        await this.adapter.probe(),
      );
      this.connected = true;
      this.reconnectAttempts = 0;
      this.observeTask = this.observe();
    } catch {
      this.store.markRuntimeOffline(required(this.context, "adapter context").installationId);
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    this.nextConnectAt =
      Date.now() +
      retryDelay(
        ++this.reconnectAttempts,
        Math.random,
        this.options.reconnectMs,
        this.options.retryCapMs,
      );
  }
  private async cancelOne() {
    const row = this.store.db
      .query<
        {
          id: RuntimeExecutionId;
          runtime_execution_opaque_id: string;
          binding_id: BindingId;
          binding_epoch: number;
          installation_id: RuntimeInstallationId;
          session_opaque_id: string;
          delivery_policy_json: string;
          task_id: `tsk_${string}`;
          requester_principal_id: `prn_${string}`;
        },
        []
      >(
        "SELECT e.id,e.runtime_execution_opaque_id,e.binding_id,e.binding_epoch,b.installation_id,b.session_opaque_id,b.delivery_policy_json,i.task_id,t.requester_principal_id FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN a2a_tasks t ON t.id=i.task_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE t.cancellation_requested=1 AND t.state NOT IN ('completed','failed','canceled','rejected') AND e.state IN ('accepted','started','awaiting-local-input') LIMIT 1",
      )
      .get();
    if (!row || !interruptOnCancel(row.delivery_policy_json)) return false;
    const result = await this.adapter.cancel({
      execution: {
        normalizedId: row.id,
        opaqueId: row.runtime_execution_opaque_id,
        session: {
          installationId: row.installation_id,
          opaqueId: row.session_opaque_id,
        },
        bindingId: row.binding_id,
        bindingEpoch: row.binding_epoch,
      },
      reason: "A2A cancellation requested",
    });
    if (result.outcome !== "accepted" && result.outcome !== "not-running") return false;
    this.store.db
      .query(
        "UPDATE runtime_executions SET state='interrupted',completed_at_ms=?,updated_at_ms=? WHERE id=? AND state IN ('accepted','started','awaiting-local-input')",
      )
      .run(Date.now(), Date.now(), row.id);
    try {
      this.store.setTaskState(
        row.task_id,
        row.requester_principal_id,
        TaskState.Canceled,
        "Canceled by requester",
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("TASK_STATE_CONFLICT"))
        throw error;
    }
    return true;
  }
  private lease() {
    return telemetry.traceSync("delivery.lease", () =>
      this.store.write(() => {
        const now = Date.now();
        this.store.db
          .query(
            "UPDATE delivery_intents SET state='failed-terminal',state_reason='deadline-expired',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state IN ('pending','deferred') AND deadline_ms IS NOT NULL AND deadline_ms<=?",
          )
          .run(now, now);
        const rows = this.store.db
            .query<DeliveryIntentRow, [number, number, number]>(
              "SELECT * FROM delivery_intents WHERE state IN ('pending','deferred') AND not_before_ms<=? AND (deadline_ms IS NULL OR deadline_ms>?) AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=?) ORDER BY priority DESC,not_before_ms,created_at_ms LIMIT 100",
            )
            .all(now, now, now),
          row = rows.find((item) => !this.lanes.has(item.target_agent_id));
        if (!row) return null;
        this.store.db
          .query(
            "UPDATE delivery_intents SET state='leased',lease_owner=?,lease_generation=lease_generation+1,lease_expires_at_ms=?,updated_at_ms=? WHERE id=?",
          )
          .run(this.instanceId, now + this.options.leaseMs, now, row.id);
        return row;
      }),
    );
  }
  private async deliver(intent: DeliveryIntentRow) {
    const target = this.store.agent(intent.target_agent_id);
    if (!target?.enabled) return this.failTerminal(intent.id, "target-disabled");
    const now = Date.now(),
      pinned = intent.pinned_binding_id
        ? this.store.db
            .query<BindingRow, [BindingId, number | null]>(
              "SELECT * FROM runtime_bindings WHERE id=? AND epoch=?",
            )
            .get(intent.pinned_binding_id, intent.pinned_binding_epoch)
        : undefined;
    if (pinned && pinned.status !== "active" && pinned.continuity_policy === "strict")
      return this.failTerminal(intent.id, "strict-binding-revoked");
    const binding =
      pinned?.status === "active"
        ? pinned
        : this.store.db
            .query<BindingRow, [`agt_${string}`]>(
              "SELECT * FROM runtime_bindings WHERE agent_id=? AND status='active'",
            )
            .get(intent.target_agent_id);
    if (!binding) return this.defer(intent.id, "offline", 30_000);
    const policy = JSON.parse(binding.delivery_policy_json);
    if (intent.mode === "wake_when_idle" && policy.wakeStrategy !== "non-atomic-idle-check")
      return this.defer(intent.id, "manual-wake-required", 30_000);
    const attempt = id("atm"),
      number = intent.attempt_count + 1;
    this.store.write(() => {
      const fenced = this.store.db
        .query("SELECT 1 FROM runtime_bindings WHERE id=? AND epoch=? AND status='active'")
        .get(binding.id, binding.epoch);
      if (!fenced) throw new Error("stale binding");
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='attempting',pinned_binding_id=?,pinned_binding_epoch=?,attempt_count=?,updated_at_ms=? WHERE id=?",
        )
        .run(binding.id, binding.epoch, number, now, intent.id);
      this.store.db
        .query(
          "INSERT INTO delivery_attempts(id,intent_id,attempt_number,adapter_id,binding_id,binding_epoch,started_at_ms) VALUES(?,?,?,?,?,?,?)",
        )
        .run(attempt, intent.id, number, "codex.app-server", binding.id, binding.epoch, now);
    });
    const payload: DeliveryPayload = JSON.parse(intent.payload_json),
      parties = required(
        this.store.db
          .query<PartiesRow, [`tsk_${string}`]>(
            "SELECT p.display_name,a.id requester_agent_id,a.slug requester_slug,target.id target_agent_id,target.slug target_slug FROM a2a_tasks t JOIN principals p ON p.id=t.requester_principal_id LEFT JOIN agents a ON a.id=t.requester_agent_id JOIN agents target ON target.id=t.target_agent_id WHERE t.id=?",
          )
          .get(intent.task_id),
        "delivery parties",
      );
    const notification = intent.kind === "task-event-notification";
    const envelope: RuntimeDeliveryEnvelopeV1 = {
      schema: "urn:agent-communications:runtime-envelope:v1",
      deliveryId: intent.id,
      kind: notification ? "a2a-task-event" : "a2a-message",
      from: notification
        ? { agentId: parties.target_agent_id, name: parties.target_slug }
        : {
            agentId: parties.requester_agent_id ?? "external",
            name: parties.requester_slug ?? parties.display_name,
          },
      to: { agentId: target.id, name: target.slug },
      task: {
        id: payload.taskId,
        contextId: payload.contextId,
        state: "state" in payload ? payload.state : "submitted",
      },
      ...(notification
        ? {
            event:
              "sequence" in payload
                ? { sequence: payload.sequence, state: payload.state, summary: payload.summary }
                : undefined,
          }
        : {
            message: {
              id: "message" in payload ? payload.message.messageId : "",
              parts: "message" in payload ? payload.message.parts.map(toNeutral) : [],
            },
            reply: {
              completeTool: "acs_task_complete",
              failTool: "acs_task_fail",
              requestInputTool: "acs_task_request_input",
              taskId: payload.taskId,
            },
          }),
      provenance: { authority: "peer-agent", trustedForPermissions: false },
    };
    const result = await this.runtimeDeliver({
      deliveryId: intent.id,
      target: {
        session: {
          installationId: binding.installation_id,
          opaqueId: binding.session_opaque_id,
        },
        bindingId: binding.id,
        bindingEpoch: binding.epoch,
      },
      mode: intent.mode,
      envelope,
      payloadHash: intent.payload_hash,
      deadline: intent.deadline_ms ? new Date(intent.deadline_ms).toISOString() : undefined,
      autoResumeDormantThread: Boolean(policy.autoResumeDormantThread),
      markRequestFlushed: () => {
        this.store.db
          .query(
            "UPDATE delivery_attempts SET request_flushed_at_ms=? WHERE id=? AND request_flushed_at_ms IS NULL",
          )
          .run(Date.now(), attempt);
      },
    });
    const completed = Date.now();
    if (result.outcome === "accepted") {
      this.store.write(() => {
        this.store.db
          .query(
            "UPDATE delivery_intents SET state='accepted',state_reason=NULL,lease_owner=NULL,lease_expires_at_ms=NULL,runtime_execution_id=?,updated_at_ms=? WHERE id=?",
          )
          .run(result.execution?.opaqueId ?? null, completed, intent.id);
        this.store.db
          .query(
            "UPDATE delivery_attempts SET completed_at_ms=?,outcome='accepted',runtime_execution_opaque_id=?,evidence_json=? WHERE id=?",
          )
          .run(
            completed,
            result.execution?.opaqueId ?? null,
            JSON.stringify(result.evidence),
            attempt,
          );
        if (result.execution)
          this.store.db
            .query(
              "INSERT INTO runtime_executions(id,intent_id,binding_id,binding_epoch,runtime_execution_opaque_id,state,accepted_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'accepted',?,?)",
            )
            .run(
              id("exe"),
              intent.id,
              binding.id,
              binding.epoch,
              result.execution.opaqueId,
              completed,
              completed,
            );
      });
      if (result.execution) {
        const principal = required(
          this.store.db
            .query<{ id: `prn_${string}` }, [BindingId]>(
              "SELECT id FROM principals WHERE binding_id=?",
            )
            .get(binding.id),
          "binding principal",
        );
        this.store.setTaskState(intent.task_id, principal.id, TaskState.Working);
      }
    } else if (result.outcome === "deferred") {
      this.finishAttempt(attempt, "deferred", result.reason);
      this.defer(
        intent.id,
        result.reason,
        result.retryAfterMs ??
          retryDelay(number, Math.random, this.options.retryBaseMs, this.options.retryCapMs),
      );
    } else if (result.outcome === "acceptance-unknown") {
      telemetry.increment("acs_acceptance_unknown_total");
      this.finishAttempt(
        attempt,
        "acceptance-unknown",
        result.ambiguity,
        result.reconciliationToken,
      );
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='acceptance-unknown',state_reason=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
        )
        .run(result.ambiguity, completed, intent.id);
    } else {
      this.finishAttempt(attempt, "rejected", result.reason);
      this.store.db
        .query(
          "UPDATE delivery_intents SET state=?,state_reason=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
        )
        .run(
          result.retryable ? "deferred" : "failed-terminal",
          result.reason,
          completed,
          intent.id,
        );
    }
  }
  private defer(intentId: string, reason: string, delay: number) {
    const now = Date.now();
    this.store.db
      .query(
        "UPDATE delivery_intents SET state='deferred',state_reason=?,not_before_ms=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(reason, now + delay, now, intentId);
  }
  private failTerminal(intentId: string, reason: string) {
    this.store.db
      .query(
        "UPDATE delivery_intents SET state='failed-terminal',state_reason=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?",
      )
      .run(reason, Date.now(), intentId);
  }
  private async runtimeDeliver(request: RuntimeDeliveryRequest) {
    const started = performance.now();
    telemetry.increment("acs_delivery_attempts_total", {
      adapter: this.adapter.descriptor.adapterId,
    });
    const renew = setInterval(
      () => {
        const now = Date.now();
        this.store.db
          .query(
            "UPDATE delivery_intents SET lease_expires_at_ms=?,updated_at_ms=? WHERE id=? AND state='attempting' AND lease_owner=?",
          )
          .run(now + this.options.leaseMs, now, request.deliveryId, this.instanceId);
      },
      Math.max(25, Math.floor(this.options.leaseMs / 2)),
    );
    try {
      return await telemetry.trace("runtime.deliver", () => this.adapter.deliver(request));
    } finally {
      clearInterval(renew);
      telemetry.observe("acs_delivery_latency_ms", performance.now() - started, {
        adapter: this.adapter.descriptor.adapterId,
      });
    }
  }
  private recoverExpiredLeases() {
    const now = Date.now();
    this.store.write(() => {
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='pending',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state='leased' AND lease_expires_at_ms<=?",
        )
        .run(now, now);
      this.store.db
        .query(
          "UPDATE delivery_intents AS i SET state='pending',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state='attempting' AND lease_expires_at_ms<=? AND NOT EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.intent_id=i.id AND a.attempt_number=i.attempt_count AND a.request_flushed_at_ms IS NOT NULL)",
        )
        .run(now, now);
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='acceptance-unknown',state_reason='request-flushed-no-response',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state='attempting' AND lease_expires_at_ms<=?",
        )
        .run(now, now);
    });
  }
  private finishAttempt(attempt: string, outcome: string, error: string, token?: string) {
    this.store.db
      .query(
        "UPDATE delivery_attempts SET completed_at_ms=?,outcome=?,error_code=?,reconciliation_token=? WHERE id=?",
      )
      .run(Date.now(), outcome, error, token ?? null, attempt);
  }
  private async observe() {
    for await (const event of this.adapter.observe(this.abort.signal)) {
      if (event.type === "adapter.connection" && event.state === "offline") {
        this.connected = false;
        this.store.markRuntimeOffline(required(this.context, "adapter context").installationId);
        this.scheduleReconnect();
        return;
      }
      this.project(event);
    }
  }
  private project(event: RuntimeEvent) {
    if (event.type === "session.observed") {
      this.store.observeSession(event.session, event.snapshot.availability);
      return;
    }
    if (event.type === "execution.started") {
      const now = Date.now();
      this.store.db
        .query(
          "UPDATE runtime_executions SET state='started',started_at_ms=?,updated_at_ms=? WHERE runtime_execution_opaque_id=? AND state='accepted'",
        )
        .run(now, now, event.execution.opaqueId);
      return;
    }
    if (event.type === "execution.awaiting-local-input") {
      this.store.db
        .query(
          "UPDATE runtime_executions SET state='awaiting-local-input',updated_at_ms=? WHERE runtime_execution_opaque_id=? AND state IN ('accepted','started')",
        )
        .run(Date.now(), event.execution.opaqueId);
      return;
    }
    if (event.type !== "execution.completed") return;
    const execution = this.store.db
      .query<ExecutionRow, [string]>(
        "SELECT e.*,i.task_id,b.id binding_id FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE e.runtime_execution_opaque_id=?",
      )
      .get(event.execution.opaqueId);
    if (!execution) return;
    const taskState = this.store.db
      .query<{ state: TaskState }, [`tsk_${string}`]>("SELECT state FROM a2a_tasks WHERE id=?")
      .get(execution.task_id);
    if (
      !taskState ||
      [TaskState.Completed, TaskState.Failed, TaskState.Canceled, TaskState.Rejected].includes(
        taskState.state,
      )
    )
      return;
    const now = Date.now(),
      state =
        event.outcome === "completed"
          ? "completed"
          : event.outcome === "interrupted"
            ? "interrupted"
            : "failed";
    this.store.db
      .query(
        "UPDATE runtime_executions SET state=?,final_parts_json=?,completed_at_ms=?,updated_at_ms=? WHERE id=?",
      )
      .run(state, JSON.stringify(event.finalParts), now, now, execution.id);
    const principal = required(
        this.store.db
          .query<{ id: `prn_${string}` }, [BindingId]>(
            "SELECT id FROM principals WHERE binding_id=?",
          )
          .get(execution.binding_id),
        "binding principal",
      ),
      summary = event.finalParts
        .filter((part): part is Extract<NeutralPart, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n");
    this.store.setTaskState(
      execution.task_id,
      principal.id,
      event.outcome === "completed" ? TaskState.Completed : TaskState.Failed,
      summary || event.outcome,
    );
  }
}

function interruptOnCancel(json: string) {
  const value: unknown = JSON.parse(json);
  return (
    typeof value === "object" &&
    value !== null &&
    "interruptOnCancel" in value &&
    value.interruptOnCancel === true
  );
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${name}`);
  return value;
}

export function retryDelay(attempt: number, random = Math.random, base = 250, cap = 30_000) {
  return Math.floor(random() * Math.min(cap, base * 2 ** Math.min(attempt, 16)));
}

function toNeutral(part: StoredPart): NeutralPart {
  if (part.content?.$case === "text")
    return {
      kind: "text",
      text: part.content.value,
      mediaType: part.mediaType === "text/markdown" ? "text/markdown" : "text/plain",
    };
  if (part.content?.$case === "url")
    return {
      kind: "uri",
      uri: part.content.value,
      name: part.filename || undefined,
      mediaType: part.mediaType || undefined,
    };
  if (part.content?.$case === "data")
    return {
      kind: "data",
      data: part.content.value,
      name: part.filename || undefined,
      mediaType: part.mediaType || "application/json",
    };
  throw new Error("unsupported content");
}

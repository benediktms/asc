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
  RuntimeEvent,
  RuntimeInstallationId,
  RuntimeExecutionId,
  NeutralPart,
} from "../../../contracts/runtime-adapter";

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
type ExecutionRow = { id: string; task_id: string; binding_id: string };

export class DeliveryScheduler {
  private timer?: Timer;
  private busy = false;
  private abort = new AbortController();
  private observeTask?: Promise<void>;
  constructor(
    private store: Store,
    private adapter: RuntimeAdapter,
    private instanceId: string,
  ) {}

  async start() {
    const installation = this.store.db
      .query("SELECT id FROM runtime_installations WHERE adapter_id='codex.app-server' LIMIT 1")
      .get() as { id: string };
    const context: RuntimeAdapterContext = {
      installationId: installation.id as RuntimeInstallationId,
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
    await this.adapter.start(context);
    this.observeTask = this.observe();
    this.timer = setInterval(() => void this.tick(), 250);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.adapter.stop({ reason: "shutdown" });
    await this.observeTask;
  }
  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await this.cancelOne()) return;
      const intent = this.lease();
      if (intent) await this.deliver(intent);
    } finally {
      this.busy = false;
    }
  }
  private async cancelOne() {
    const row = this.store.db
      .query(
        "SELECT e.id,e.runtime_execution_opaque_id,e.binding_id,e.binding_epoch,b.installation_id,b.session_opaque_id,b.delivery_policy_json,i.task_id,t.requester_principal_id FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN a2a_tasks t ON t.id=i.task_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE t.cancellation_requested=1 AND t.state NOT IN ('completed','failed','canceled','rejected') AND e.state IN ('accepted','started','awaiting-local-input') LIMIT 1",
      )
      .get() as {
      id: string;
      runtime_execution_opaque_id: string;
      binding_id: string;
      binding_epoch: number;
      installation_id: string;
      session_opaque_id: string;
      delivery_policy_json: string;
      task_id: string;
      requester_principal_id: string;
    } | null;
    if (
      !row ||
      !(JSON.parse(row.delivery_policy_json) as { interruptOnCancel?: boolean }).interruptOnCancel
    )
      return false;
    const result = await this.adapter.cancel({
      execution: {
        normalizedId: row.id as RuntimeExecutionId,
        opaqueId: row.runtime_execution_opaque_id,
        session: {
          installationId: row.installation_id as RuntimeInstallationId,
          opaqueId: row.session_opaque_id,
        },
        bindingId: row.binding_id as BindingId,
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
    return this.store.db.transaction(() => {
      const now = Date.now(),
        row = this.store.db
          .query(
            "SELECT * FROM delivery_intents WHERE state IN ('pending','deferred') AND not_before_ms<=? AND (deadline_ms IS NULL OR deadline_ms>?) AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=?) ORDER BY priority DESC,not_before_ms,created_at_ms LIMIT 1",
          )
          .get(now, now, now) as DeliveryIntentRow | null;
      if (!row) return null;
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='leased',lease_owner=?,lease_generation=lease_generation+1,lease_expires_at_ms=?,updated_at_ms=? WHERE id=?",
        )
        .run(this.instanceId, now + 30_000, now, row.id);
      return row;
    })();
  }
  private async deliver(intent: DeliveryIntentRow) {
    const now = Date.now(),
      binding = (
        intent.pinned_binding_id
          ? this.store.db
              .query("SELECT * FROM runtime_bindings WHERE id=? AND epoch=? AND status='active'")
              .get(intent.pinned_binding_id, intent.pinned_binding_epoch)
          : this.store.db
              .query("SELECT * FROM runtime_bindings WHERE agent_id=? AND status='active'")
              .get(intent.target_agent_id)
      ) as BindingRow | null;
    if (!binding) return this.defer(intent.id, "offline", 30_000);
    const policy = JSON.parse(binding.delivery_policy_json);
    if (intent.mode === "wake_when_idle" && policy.wakeStrategy !== "non-atomic-idle-check")
      return this.defer(intent.id, "manual-wake-required", 30_000);
    const attempt = id("atm"),
      number = intent.attempt_count + 1;
    this.store.db.transaction(() => {
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
          "INSERT INTO delivery_attempts(id,intent_id,attempt_number,adapter_id,binding_id,binding_epoch,started_at_ms,request_flushed_at_ms) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(attempt, intent.id, number, "codex.app-server", binding.id, binding.epoch, now, now);
    })();
    const target = this.store.agent(intent.target_agent_id),
      payload = JSON.parse(intent.payload_json) as DeliveryPayload,
      parties = this.store.db
        .query(
          "SELECT p.display_name,a.id requester_agent_id,a.slug requester_slug,target.id target_agent_id,target.slug target_slug FROM a2a_tasks t JOIN principals p ON p.id=t.requester_principal_id LEFT JOIN agents a ON a.id=t.requester_agent_id JOIN agents target ON target.id=t.target_agent_id WHERE t.id=?",
        )
        .get(intent.task_id) as PartiesRow;
    if (!target) throw new Error("target agent missing");
    const notification = intent.kind === "task-event-notification";
    const envelope: RuntimeDeliveryEnvelopeV1 = {
      schema: "urn:agent-communications:runtime-envelope:v1",
      deliveryId: intent.id as DeliveryId,
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
    const result = await this.adapter.deliver({
      deliveryId: intent.id as DeliveryId,
      target: {
        session: {
          installationId: binding.installation_id as RuntimeInstallationId,
          opaqueId: binding.session_opaque_id,
        },
        bindingId: binding.id as BindingId,
        bindingEpoch: binding.epoch,
      },
      mode: intent.mode,
      envelope,
      payloadHash: intent.payload_hash,
      deadline: intent.deadline_ms ? new Date(intent.deadline_ms).toISOString() : undefined,
    });
    const completed = Date.now();
    if (result.outcome === "accepted") {
      this.store.db.transaction(() => {
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
      })();
      if (result.execution) {
        const principal = this.store.db
          .query("SELECT id FROM principals WHERE binding_id=?")
          .get(binding.id) as { id: string };
        this.store.setTaskState(intent.task_id, principal.id, TaskState.Working);
      }
    } else if (result.outcome === "deferred") {
      this.finishAttempt(attempt, "deferred", result.reason);
      this.defer(intent.id, result.reason, result.retryAfterMs ?? retryDelay(number));
    } else if (result.outcome === "acceptance-unknown") {
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
  private recoverExpiredLeases() {
    const now = Date.now();
    this.store.db.transaction(() => {
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='pending',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state='leased' AND lease_expires_at_ms<=?",
        )
        .run(now, now);
      this.store.db
        .query(
          "UPDATE delivery_intents SET state='acceptance-unknown',state_reason='request-flushed-no-response',lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE state='attempting' AND lease_expires_at_ms<=?",
        )
        .run(now, now);
    })();
  }
  private finishAttempt(attempt: string, outcome: string, error: string, token?: string) {
    this.store.db
      .query(
        "UPDATE delivery_attempts SET completed_at_ms=?,outcome=?,error_code=?,reconciliation_token=? WHERE id=?",
      )
      .run(Date.now(), outcome, error, token ?? null, attempt);
  }
  private async observe() {
    for await (const event of this.adapter.observe(this.abort.signal)) this.project(event);
  }
  private project(event: RuntimeEvent) {
    if (event.type !== "execution.completed") return;
    const execution = this.store.db
      .query(
        "SELECT e.*,i.task_id,b.id binding_id FROM runtime_executions e JOIN delivery_intents i ON i.id=e.intent_id JOIN runtime_bindings b ON b.id=e.binding_id WHERE e.runtime_execution_opaque_id=?",
      )
      .get(event.execution.opaqueId) as ExecutionRow | null;
    if (!execution) return;
    const taskState = this.store.db
      .query("SELECT state FROM a2a_tasks WHERE id=?")
      .get(execution.task_id) as { state: string } | null;
    if (
      !taskState ||
      [TaskState.Completed, TaskState.Failed, TaskState.Canceled, TaskState.Rejected].includes(
        taskState.state as TaskState,
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
    const principal = this.store.db
        .query("SELECT id FROM principals WHERE binding_id=?")
        .get(execution.binding_id) as { id: string },
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

export function retryDelay(attempt: number, random = Math.random) {
  return Math.floor(random() * Math.min(30_000, 250 * 2 ** Math.min(attempt, 16)));
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

export enum TaskState {
  Submitted = "submitted",
  Working = "working",
  InputRequired = "input-required",
  AuthRequired = "auth-required",
  Completed = "completed",
  Failed = "failed",
  Canceled = "canceled",
  Rejected = "rejected",
}

export enum BindingState {
  Pending = "pending",
  Active = "active",
  Stale = "stale",
  Revoked = "revoked",
}

export enum DeliveryState {
  Pending = "pending",
  Leased = "leased",
  Attempting = "attempting",
  Deferred = "deferred",
  Accepted = "accepted",
  AcceptanceUnknown = "acceptance-unknown",
  FailedTerminal = "failed-terminal",
  Canceled = "canceled",
  Superseded = "superseded",
}

export enum DeliveryAttemptOutcome {
  Accepted = "accepted",
  Deferred = "deferred",
  Rejected = "rejected",
  AcceptanceUnknown = "acceptance-unknown",
}

export enum RuntimeExecutionState {
  Accepted = "accepted",
  Started = "started",
  AwaitingLocalInput = "awaiting-local-input",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
  Unknown = "unknown",
}

const terminal = new Set<TaskState>([
  TaskState.Completed,
  TaskState.Failed,
  TaskState.Canceled,
  TaskState.Rejected,
]);
const transitions: Record<TaskState, readonly TaskState[]> = {
  [TaskState.Submitted]: [
    TaskState.Working,
    TaskState.InputRequired,
    TaskState.Failed,
    TaskState.Canceled,
    TaskState.Rejected,
  ],
  [TaskState.Working]: [
    TaskState.InputRequired,
    TaskState.AuthRequired,
    TaskState.Completed,
    TaskState.Failed,
    TaskState.Canceled,
  ],
  [TaskState.InputRequired]: [TaskState.Working, TaskState.Failed, TaskState.Canceled],
  [TaskState.AuthRequired]: [TaskState.Working, TaskState.Failed, TaskState.Canceled],
  [TaskState.Completed]: [],
  [TaskState.Failed]: [],
  [TaskState.Canceled]: [],
  [TaskState.Rejected]: [],
};

export function transition(current: TaskState, next: TaskState): TaskState {
  if (current === next && terminal.has(current)) return current;
  if (!transitions[current].includes(next))
    throw new Error(`TASK_STATE_CONFLICT: ${current} -> ${next}`);
  return next;
}

const bindingTransitions: Record<BindingState, readonly BindingState[]> = {
  [BindingState.Pending]: [BindingState.Active, BindingState.Revoked],
  [BindingState.Active]: [BindingState.Stale, BindingState.Revoked],
  [BindingState.Stale]: [BindingState.Revoked],
  [BindingState.Revoked]: [],
};

export function transitionBinding(current: BindingState, next: BindingState): BindingState {
  if (!bindingTransitions[current].includes(next))
    throw new Error(`BINDING_STATE_CONFLICT: ${current} -> ${next}`);
  return next;
}

const deliveryTransitions: Record<DeliveryState, readonly DeliveryState[]> = {
  [DeliveryState.Pending]: [
    DeliveryState.Leased,
    DeliveryState.FailedTerminal,
    DeliveryState.Canceled,
    DeliveryState.Superseded,
  ],
  [DeliveryState.Leased]: [
    DeliveryState.Attempting,
    DeliveryState.Deferred,
    DeliveryState.Pending,
    DeliveryState.Canceled,
  ],
  [DeliveryState.Attempting]: [
    DeliveryState.Pending,
    DeliveryState.Accepted,
    DeliveryState.Deferred,
    DeliveryState.FailedTerminal,
    DeliveryState.AcceptanceUnknown,
  ],
  [DeliveryState.Deferred]: [
    DeliveryState.Pending,
    DeliveryState.FailedTerminal,
    DeliveryState.Canceled,
  ],
  [DeliveryState.Accepted]: [],
  [DeliveryState.AcceptanceUnknown]: [
    DeliveryState.Accepted,
    DeliveryState.Pending,
    DeliveryState.Canceled,
  ],
  [DeliveryState.FailedTerminal]: [],
  [DeliveryState.Canceled]: [],
  [DeliveryState.Superseded]: [],
};

export function transitionDelivery(current: DeliveryState, next: DeliveryState): DeliveryState {
  if (!deliveryTransitions[current].includes(next))
    throw new Error(`DELIVERY_STATE_CONFLICT: ${current} -> ${next}`);
  return next;
}

const executionTransitions: Record<RuntimeExecutionState, readonly RuntimeExecutionState[]> = {
  [RuntimeExecutionState.Accepted]: [
    RuntimeExecutionState.Started,
    RuntimeExecutionState.Completed,
    RuntimeExecutionState.Failed,
    RuntimeExecutionState.Interrupted,
    RuntimeExecutionState.Unknown,
  ],
  [RuntimeExecutionState.Started]: [
    RuntimeExecutionState.AwaitingLocalInput,
    RuntimeExecutionState.Completed,
    RuntimeExecutionState.Failed,
    RuntimeExecutionState.Interrupted,
    RuntimeExecutionState.Unknown,
  ],
  [RuntimeExecutionState.AwaitingLocalInput]: [
    RuntimeExecutionState.Started,
    RuntimeExecutionState.Completed,
    RuntimeExecutionState.Failed,
    RuntimeExecutionState.Interrupted,
    RuntimeExecutionState.Unknown,
  ],
  [RuntimeExecutionState.Completed]: [],
  [RuntimeExecutionState.Failed]: [],
  [RuntimeExecutionState.Interrupted]: [],
  [RuntimeExecutionState.Unknown]: [
    RuntimeExecutionState.Accepted,
    RuntimeExecutionState.Started,
    RuntimeExecutionState.AwaitingLocalInput,
    RuntimeExecutionState.Completed,
    RuntimeExecutionState.Failed,
    RuntimeExecutionState.Interrupted,
  ],
};

export function transitionRuntimeExecution(
  current: RuntimeExecutionState,
  next: RuntimeExecutionState,
): RuntimeExecutionState {
  if (!executionTransitions[current].includes(next))
    throw new Error(`EXECUTION_STATE_CONFLICT: ${current} -> ${next}`);
  return next;
}

export type IdPrefix =
  | "agt"
  | "prn"
  | "ins"
  | "bnd"
  | "ctx"
  | "tsk"
  | "msg"
  | "evt"
  | "int"
  | "atm"
  | "exe"
  | "sub"
  | "tok"
  | "clm";

export function id<Prefix extends IdPrefix>(
  prefix: Prefix,
  now = Date.now(),
): `${Prefix}_${string}` {
  return `${prefix}_${uuidV7(now)}`;
}

export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index++)
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 255n);
  bytes[6] = 0x70 | ((bytes.at(6) ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes.at(8) ?? 0) & 0x3f);
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function agentSlug(value: string): string {
  const slug = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug))
    throw new Error("VALIDATION_FAILED: invalid agent slug");
  return slug;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("VALIDATION_FAILED: value is not JSON");
  return encoded;
}

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
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index++)
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 255n);
  bytes[6] = 0x70 | ((bytes.at(6) ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes.at(8) ?? 0) & 0x3f);
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function agentSlug(value: string): string {
  const slug = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug))
    throw new Error("VALIDATION_FAILED: invalid agent slug");
  return slug;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

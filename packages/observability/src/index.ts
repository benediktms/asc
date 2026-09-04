export type MetricName =
  | "acs_a2a_requests_total"
  | "acs_a2a_request_duration_ms"
  | "acs_tasks_by_state"
  | "acs_delivery_intents_by_state"
  | "acs_delivery_attempts_total"
  | "acs_delivery_latency_ms"
  | "acs_acceptance_unknown_total"
  | "acs_runtime_sessions_by_state"
  | "acs_sqlite_busy_total"
  | "acs_control_requests_total";
export type SpanName =
  | "a2a.receive"
  | "task.accept"
  | "delivery.lease"
  | "runtime.inspect"
  | "runtime.deliver"
  | "codex.rpc"
  | "task.transition"
  | "task.notify";

type Labels = Record<string, string>;
type Point = { name: MetricName; labels: Labels; value: number; count?: number };
const metricNames: MetricName[] = [
  "acs_a2a_requests_total",
  "acs_a2a_request_duration_ms",
  "acs_tasks_by_state",
  "acs_delivery_intents_by_state",
  "acs_delivery_attempts_total",
  "acs_delivery_latency_ms",
  "acs_acceptance_unknown_total",
  "acs_runtime_sessions_by_state",
  "acs_sqlite_busy_total",
  "acs_control_requests_total",
];

export class Telemetry {
  private counters = new Map<string, Point>();
  private gauges = new Map<string, Point>();
  private histograms = new Map<string, Point>();
  private spans: Array<{
    name: SpanName;
    startedAt: string;
    durationMs: number;
    status: "ok" | "error";
  }> = [];

  increment(name: MetricName, labels: Labels = {}, amount = 1) {
    const key = metricKey(name, labels),
      point = this.counters.get(key) ?? { name, labels, value: 0 };
    point.value += amount;
    this.counters.set(key, point);
  }

  gauge(name: MetricName, value: number, labels: Labels = {}) {
    this.gauges.set(metricKey(name, labels), { name, labels, value });
  }

  observe(name: MetricName, value: number, labels: Labels = {}) {
    const key = metricKey(name, labels),
      point = this.histograms.get(key) ?? { name, labels, value: 0, count: 0 };
    point.value += value;
    point.count = (point.count ?? 0) + 1;
    this.histograms.set(key, point);
  }

  snapshot() {
    const points = [
      ...this.counters.values(),
      ...this.gauges.values(),
      ...this.histograms.values(),
    ];
    for (const name of metricNames)
      if (!points.some((point) => point.name === name)) points.push({ name, labels: {}, value: 0 });
    return points
      .map((point) => ({
        name: point.name,
        labels: Object.fromEntries(Object.entries(point.labels)),
        value: point.value,
        count: point.count,
      }))
      .toSorted((left, right) =>
        metricKey(left.name, left.labels).localeCompare(metricKey(right.name, right.labels)),
      );
  }

  traceSync<T>(name: SpanName, operation: () => T): T {
    const startedAt = new Date().toISOString(),
      started = performance.now();
    try {
      const result = operation();
      this.recordSpan(name, startedAt, performance.now() - started, "ok");
      return result;
    } catch (error) {
      this.recordSpan(name, startedAt, performance.now() - started, "error");
      throw error;
    }
  }

  async trace<T>(name: SpanName, operation: () => Promise<T>): Promise<T> {
    const startedAt = new Date().toISOString(),
      started = performance.now();
    try {
      const result = await operation();
      this.recordSpan(name, startedAt, performance.now() - started, "ok");
      return result;
    } catch (error) {
      this.recordSpan(name, startedAt, performance.now() - started, "error");
      throw error;
    }
  }

  traceSnapshot() {
    return this.spans.map((span) => ({
      name: span.name,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      status: span.status,
    }));
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.spans.length = 0;
  }

  private recordSpan(
    name: SpanName,
    startedAt: string,
    durationMs: number,
    status: "ok" | "error",
  ) {
    this.spans.push({ name, startedAt, durationMs, status });
    if (this.spans.length > 256) this.spans.shift();
  }
}

export const telemetry = new Telemetry();

function metricKey(name: MetricName, labels: Labels) {
  return `${name}:${Object.entries(labels)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}`;
}

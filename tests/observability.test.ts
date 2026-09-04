import { expect, test } from "bun:test";
import { Telemetry } from "../packages/observability/src/index";

test("records counters, gauges, histograms, and zero-valued required metrics", () => {
  const telemetry = new Telemetry();
  telemetry.increment("acs_a2a_requests_total", { method: "SendMessage" });
  telemetry.gauge("acs_tasks_by_state", 2, { state: "working" });
  telemetry.observe("acs_a2a_request_duration_ms", 4);
  telemetry.observe("acs_a2a_request_duration_ms", 6);
  const points = telemetry.snapshot();
  expect(points.find((point) => point.name === "acs_a2a_requests_total")?.value).toBe(1);
  expect(points.find((point) => point.name === "acs_tasks_by_state")?.value).toBe(2);
  expect(points.find((point) => point.name === "acs_a2a_request_duration_ms")).toMatchObject({
    value: 10,
    count: 2,
  });
  const names = points.map((point) => point.name);
  expect(names).toContain("acs_delivery_attempts_total");
  expect(names).toContain("acs_runtime_sessions_by_state");
  expect(names).toContain("acs_sqlite_busy_total");
});

import { describe, expect, test } from "bun:test";
import {
  agentSlug,
  BindingState,
  canonical,
  DeliveryState,
  id,
  RuntimeExecutionState,
  TaskState,
  transition,
  transitionBinding,
  transitionDelivery,
  transitionRuntimeExecution,
} from "../packages/domain/src/index";

describe("domain", () => {
  test("UUIDv7 IDs are prefixed and time-sortable", () => {
    const first = id("tsk", 1_000),
      second = id("tsk", 2_000),
      current = id("tsk", 1_788_533_373_305);
    expect(first).toMatch(
      /^tsk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first < second).toBe(true);
    expect(current.slice(4, 17)).toBe("01a06ce5-7979");
  });
  test("state transitions reject illegal and terminal changes", () => {
    expect(transition(TaskState.Submitted, TaskState.Working)).toBe(TaskState.Working);
    expect(transition(TaskState.Completed, TaskState.Completed)).toBe(TaskState.Completed);
    expect(() => transition(TaskState.Completed, TaskState.Working)).toThrow("TASK_STATE_CONFLICT");
    expect(transitionBinding(BindingState.Active, BindingState.Revoked)).toBe(BindingState.Revoked);
    expect(() => transitionBinding(BindingState.Revoked, BindingState.Active)).toThrow(
      "BINDING_STATE_CONFLICT",
    );
    expect(transitionDelivery(DeliveryState.Leased, DeliveryState.Attempting)).toBe(
      DeliveryState.Attempting,
    );
    expect(() => transitionDelivery(DeliveryState.Attempting, DeliveryState.Canceled)).toThrow(
      "DELIVERY_STATE_CONFLICT",
    );
    expect(() => transitionDelivery(DeliveryState.FailedTerminal, DeliveryState.Pending)).toThrow(
      "DELIVERY_STATE_CONFLICT",
    );
    expect(
      transitionRuntimeExecution(
        RuntimeExecutionState.AwaitingLocalInput,
        RuntimeExecutionState.Completed,
      ),
    ).toBe(RuntimeExecutionState.Completed);
    expect(() =>
      transitionRuntimeExecution(RuntimeExecutionState.Completed, RuntimeExecutionState.Started),
    ).toThrow("EXECUTION_STATE_CONFLICT");
  });
  test("normalization is deterministic", () => {
    expect(agentSlug("@backend")).toBe("backend");
    expect(canonical({ b: 1, a: [2] })).toBe('{"a":[2],"b":1}');
    expect(canonical({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
    expect(() => canonical(undefined)).toThrow("value is not JSON");
  });
});

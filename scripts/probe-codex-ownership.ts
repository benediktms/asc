#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { CodexAppServerClient } from "../packages/runtime-codex/src/app-server-client";

export type OwnershipProbeEvent = {
  at: string;
  client: string;
  direction: "lifecycle" | "notification" | "request" | "snapshot";
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  runtimeVersion?: string;
  shape?: string[];
  fingerprint?: string;
};

type ProbeOptions = {
  socket: string;
  output: string;
  scenario: "observe" | "reconnect" | "resume";
  durationMs: number;
  phaseMs: number;
  threadId?: string;
};

export function ownershipProbeEvent(
  client: string,
  direction: OwnershipProbeEvent["direction"],
  method: string,
  params?: unknown,
): OwnershipProbeEvent {
  const identifiers = findIdentifiers(params),
    runtimeVersion =
      method === "connected" && isRecord(params) && typeof params.userAgent === "string"
        ? params.userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.at(0)
        : undefined;
  return {
    at: new Date().toISOString(),
    client,
    direction,
    method,
    ...identifiers,
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(params === undefined
      ? {}
      : {
          shape: valueShape(params),
          fingerprint: createHash("sha256")
            .update(
              direction === "snapshot" ? snapshotConfiguration(params) : canonicalShape(params),
            )
            .digest("base64url"),
        }),
  };
}

export function parseOwnershipProbeArgs(args: string[]): ProbeOptions {
  const values = new Map<string, string>(),
    supported = new Set(["socket", "output", "scenario", "duration-ms", "phase-ms", "thread"]);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!option?.startsWith("--")) throw new Error(`unexpected argument: ${option ?? ""}`);
    if (!supported.has(option.slice(2))) throw new Error(`unknown option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${option}`);
    values.set(option.slice(2), value);
    index++;
  }
  const socket = values.get("socket") ?? process.env.ACS_CODEX_SOCKET,
    output = values.get("output"),
    scenario = values.get("scenario") ?? "observe",
    durationMs = positiveInteger(values.get("duration-ms") ?? "30000", "duration-ms"),
    phaseMs = positiveInteger(values.get("phase-ms") ?? "1000", "phase-ms"),
    threadId = values.get("thread");
  if (!socket) throw new Error("--socket or ACS_CODEX_SOCKET is required");
  if (!output) throw new Error("--output is required");
  if (scenario !== "observe" && scenario !== "reconnect" && scenario !== "resume")
    throw new Error("--scenario must be observe, reconnect, or resume");
  if (scenario === "resume" && !threadId) throw new Error("--thread is required for resume");
  return { socket, output, scenario, durationMs, phaseMs, threadId };
}

export async function runOwnershipProbe(options: ProbeOptions) {
  writeFileSync(options.output, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const clients = new Map<string, CodexAppServerClient>();
  const record = (event: OwnershipProbeEvent) =>
    appendFileSync(options.output, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  const connect = async (name: string) => {
    const client = new CodexAppServerClient(options.socket);
    client.onNotification = (method, params) =>
      record(ownershipProbeEvent(name, "notification", method, params));
    client.onRequest = (_requestId, method, params) => {
      // Deliberately do not answer app-server requests. The probe is an observer,
      // never an approval or user-input owner.
      record(ownershipProbeEvent(name, "request", method, params));
    };
    client.onClose = () => record(ownershipProbeEvent(name, "lifecycle", "disconnected"));
    const initialized = await client.start();
    clients.set(name, client);
    record(ownershipProbeEvent(name, "lifecycle", "connected", initialized));
    return client;
  };
  const disconnect = (name: string) => {
    clients.get(name)?.close();
    clients.delete(name);
    record(ownershipProbeEvent(name, "lifecycle", "closed-by-probe"));
  };
  try {
    const first = await connect("observer-a");
    await connect("observer-b");
    if (options.threadId) await snapshot(first, "observer-a", options.threadId, record, "before");
    if (options.scenario === "reconnect") {
      await Bun.sleep(options.phaseMs);
      disconnect("observer-a");
      await Bun.sleep(options.phaseMs);
      await connect("observer-a");
      await Bun.sleep(options.phaseMs);
      disconnect("observer-b");
      await Bun.sleep(options.phaseMs);
      await connect("observer-b");
    } else if (options.scenario === "resume") {
      if (!options.threadId) throw new Error("resume scenario requires a thread");
      await first.resumeThread(options.threadId);
      record(
        ownershipProbeEvent("observer-a", "lifecycle", "thread/resume-completed", {
          threadId: options.threadId,
        }),
      );
      await snapshot(first, "observer-a", options.threadId, record, "after-resume");
    }
    await Bun.sleep(options.durationMs);
    const current = clients.get("observer-a") ?? clients.get("observer-b");
    if (current && options.threadId)
      await snapshot(
        current,
        clients.has("observer-a") ? "observer-a" : "observer-b",
        options.threadId,
        record,
        "after",
      );
  } finally {
    for (const client of clients.values()) client.close();
  }
}

async function snapshot(
  client: CodexAppServerClient,
  clientName: string,
  threadId: string,
  record: (event: OwnershipProbeEvent) => void,
  phase: string,
) {
  const response = await client.request("thread/read", { threadId, includeTurns: false });
  record(ownershipProbeEvent(clientName, "snapshot", phase, response));
}

function findIdentifiers(value: unknown) {
  const result: { threadId?: string; turnId?: string; itemId?: string } = {};
  visit(value, (key, item) => {
    if (typeof item !== "string") return;
    if (!result.threadId && key === "threadId") result.threadId = item;
    if (!result.turnId && key === "turnId") result.turnId = item;
    if (!result.itemId && key === "itemId") result.itemId = item;
  });
  return result;
}

function valueShape(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 5) return [`${prefix}:depth-limit`];
  if (Array.isArray(value)) {
    const members = value.slice(0, 3).flatMap((item) => valueShape(item, `${prefix}[]`, depth + 1));
    return [...new Set(members)].toSorted();
  }
  if (!isRecord(value)) return [`${prefix}:${value === null ? "null" : typeof value}`];
  return Object.keys(value)
    .toSorted()
    .flatMap((key) => valueShape(value[key], prefix ? `${prefix}.${key}` : key, depth + 1));
}

function canonicalShape(value: unknown) {
  return valueShape(value).join("\n");
}

function snapshotConfiguration(value: unknown) {
  const thread = isRecord(value) && isRecord(value.thread) ? value.thread : {};
  return JSON.stringify(
    Object.fromEntries(
      [
        "extra",
        "ephemeral",
        "section",
        "projectId",
        "historyMode",
        "modelProvider",
        "model",
        "reasoningEffort",
        "source",
        "canAcceptDirectInput",
        "threadSource",
        "agentRole",
      ]
        .filter((key) => key in thread)
        .map((key) => [key, thread[key]]),
    ),
  );
}

function visit(value: unknown, callback: (key: string, value: unknown) => void) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    callback(key, item);
    visit(item, callback);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
  return parsed;
}

if (import.meta.main)
  runOwnershipProbe(parseOwnershipProbeArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

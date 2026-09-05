import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptA2AMessageCommand } from "../contracts/a2a-application-port";
import type { RuntimeInstallationId } from "../contracts/runtime-adapter";
import { A2AApplication } from "../packages/application/src/a2a";
import { Store, type Paths } from "../packages/storage-sqlite/src/index";
import {
  CodexThreadLifecyclePrototype,
  spawnAndRegisterPrototype,
  type CodexThreadStarter,
  type SpawnedPrototypeAgent,
} from "../spikes/runtime-spawn/prototype";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("two dynamically started Codex logical agents communicate directly through ASC", async () => {
  const root = mkdtempSync(join(tmpdir(), "acs-runtime-spawn-spike-"));
  roots.push(root);
  const paths: Paths = {
      data: join(root, "acs.db"),
      runtime: join(root, "control.sock"),
      token: join(root, "control.token"),
      bridgeToken: join(root, "bridge.token"),
      secret: join(root, "secret.key"),
    },
    store = new Store(paths),
    installation = store.db
      .query<{ id: RuntimeInstallationId }, []>(
        "SELECT id FROM runtime_installations WHERE harness_id='codex'",
      )
      .get();
  if (!installation) throw new Error("Codex installation missing");
  const starts: unknown[] = [],
    client: CodexThreadStarter = {
      async startThread(params) {
        starts.push(params);
        return { thread: { id: `codex-thread-${starts.length}` } };
      },
    },
    lifecycle = new CodexThreadLifecyclePrototype(
      client,
      installation.id,
      () => "2026-09-05T00:00:00.000Z",
    ),
    payments = await spawn(store, lifecycle, installation.id, "payments", "/repos/payments", 1),
    bookings = await spawn(store, lifecycle, installation.id, "bookings", "/repos/bookings", 2),
    application = new A2AApplication(store),
    paymentsToBookings = await application.acceptMessage(
      message(payments, bookings, "payments-contract", "Use PaymentAuthorization v2"),
    ),
    bookingsToPayments = await application.acceptMessage(
      message(bookings, payments, "bookings-question", "Is idempotencyKey required?"),
    );

  expect(starts).toEqual([
    { cwd: "/repos/payments", approvalPolicy: "on-request", sandbox: "workspace-write" },
    { cwd: "/repos/bookings", approvalPolicy: "on-request", sandbox: "workspace-write" },
  ]);
  expect([payments.sessionOpaqueId, bookings.sessionOpaqueId]).toEqual([
    "codex-thread-1",
    "codex-thread-2",
  ]);
  expect(paymentsToBookings).toMatchObject({
    targetAgentId: bookings.agent.id,
    requesterPrincipalId: payments.principal.id,
    state: "submitted",
  });
  expect(bookingsToPayments).toMatchObject({
    targetAgentId: payments.agent.id,
    requesterPrincipalId: bookings.principal.id,
    state: "submitted",
  });
  expect(
    store
      .agents()
      .map((agent) => agent.slug)
      .toSorted(),
  ).toEqual(["bookings", "payments"]);
  expect(
    store.db.query<{ count: number }, []>("SELECT count(*) count FROM runtime_bindings").get()
      ?.count,
  ).toBe(2);
  store.close();
});

async function spawn(
  store: Store,
  lifecycle: CodexThreadLifecyclePrototype,
  installationId: RuntimeInstallationId,
  slug: string,
  path: string,
  sequence: number,
) {
  return spawnAndRegisterPrototype(
    store,
    lifecycle,
    {
      requestId: `spawn-${sequence}`,
      installationId,
      nameHint: slug,
      workspace: { kind: "existing", path },
      runtimeProfileId: "codex-safe-worker",
      runtimeOptions: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    },
    slug,
  );
}

function message(
  from: SpawnedPrototypeAgent,
  to: SpawnedPrototypeAgent,
  id: string,
  text: string,
): AcceptA2AMessageCommand {
  return {
    principal: from.principal,
    target: {
      agentId: to.agent.id,
      slug: to.agent.slug,
      profileRevision: to.agent.profile_revision,
    },
    requestCorrelationId: id,
    externalMessageId: id,
    role: "agent",
    parts: [{ kind: "text", text }],
    requestMetadata: {},
    messageMetadata: {},
    delivery: {
      mode: "wake_when_idle",
      priority: "normal",
      notifyOn: ["terminal"],
      replyExpected: true,
    },
    canonicalRequestHash: `spike-${id}`,
  };
}

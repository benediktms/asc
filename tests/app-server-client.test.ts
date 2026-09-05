import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAppServerClient } from "../packages/runtime-codex/src/app-server-client";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Codex app-server transport", () => {
  test("rejects a missing app-server socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-codex-missing-"));
    roots.push(root);
    const client = new CodexAppServerClient(join(root, "missing.sock"));
    await expect(client.start()).rejects.toThrow("app-server socket unavailable");
  });

  test("upgrades over a Unix socket and omits jsonrpc", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-codex-"));
    roots.push(root);
    const path = join(root, "app.sock");
    let received = "";
    const server = Bun.listen({
      unix: path,
      socket: {
        open() {},
        data(socket, data) {
          const text = Buffer.from(data).toString();
          if (text.startsWith("GET ")) {
            const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.at(1);
            if (!key) throw new Error("missing WebSocket key");
            const accept = createHash("sha1")
              .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest("base64");
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            return;
          }
          const frame = Buffer.from(data),
            length = byte(frame, 1) & 0x7f,
            offset = length === 126 ? 4 : 2,
            mask = frame.subarray(offset, offset + 4),
            payload = frame.subarray(
              offset + 4,
              offset + 4 + (length === 126 ? frame.readUInt16BE(2) : length),
            );
          received = Buffer.from(
            payload.map((value, index) => value ^ byte(mask, index % 4)),
          ).toString();
          const request = JSON.parse(received),
            body = Buffer.from(
              JSON.stringify({
                id: request.id,
                result: { userAgent: "fake", platformFamily: "unix", platformOs: "test" },
              }),
            );
          socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
        },
        close() {},
        error() {},
      },
    });
    const client = new CodexAppServerClient(path);
    const initialized = await client.start();
    expect(received).not.toContain("jsonrpc");
    expect(initialized.userAgent).toBe("fake");
    client.close();
    server.stop();
  });

  test("times out when the app-server never upgrades", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-codex-timeout-"));
    roots.push(root);
    const path = join(root, "app.sock"),
      server = Bun.listen({
        unix: path,
        socket: { open() {}, data() {}, close() {}, error() {} },
      }),
      client = new CodexAppServerClient(path, 10_000, 25);
    await expect(client.start()).rejects.toThrow("app-server connection timeout");
    await Bun.sleep(50);
    client.close();
    server.stop();
  });

  test("rejects requests above the configured in-flight limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-codex-overload-"));
    roots.push(root);
    const path = join(root, "app.sock");
    let markPending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
        markPending = resolve;
      }),
      server = Bun.listen({
        unix: path,
        socket: {
          open() {},
          data(socket, data) {
            const text = Buffer.from(data).toString();
            if (!text.startsWith("GET ")) {
              markPending?.();
              return;
            }
            const key = text.match(/Sec-WebSocket-Key: (.+)\r/i)?.at(1);
            if (!key) throw new Error("missing WebSocket key");
            const accept = createHash("sha1")
              .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest("base64");
            socket.write(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
          },
          close() {},
          error() {},
        },
      }),
      client = new CodexAppServerClient(path, 10_000, 1_000, 1),
      starting = client.start();
    await pending;
    await expect(client.request("thread/list", {})).rejects.toThrow("app-server overloaded");
    client.close();
    await expect(starting).rejects.toThrow("app-server connection closed");
    server.stop();
  });
});

function byte(buffer: Uint8Array, index: number) {
  const value = buffer.at(index);
  if (value === undefined) throw new Error("invalid WebSocket frame");
  return value;
}

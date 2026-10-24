import { describe, it, expect } from "vitest";
import { whipResource } from "./whip";
describe("WHIP session boundary", () => {
  const origin = "http://localhost:5173",
    base = "/ingest/s-12345678901234567890123456789012/whip";
  it("accepts only the exact same-origin publishing resource namespace", () => {
    expect(whipResource(base + "/abc", base, origin)).toBe(
      origin + base + "/abc",
    );
    for (const target of [
      "https://evil.example/x",
      "/api/v1/auth/logout",
      "//evil.example/x",
      base + "/abc?secret=x",
      base + "/abc#x",
      base + "/../other",
    ])
      expect(() => whipResource(target, base, origin)).toThrow();
  });
});

import { vi, afterEach } from "vitest";
import { publishWhip } from "./whip";
import type { Publishing } from "@streamshield/shared";

class Peer extends EventTarget {
  static last: Peer;
  connectionState = "connecting";
  iceGatheringState = "complete";
  localDescription = { sdp: "test offer" };
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  constructor() {
    super();
    Peer.last = this;
  }
  createOffer = vi.fn(async () => this.localDescription);
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  getStats = vi.fn();
  transition(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}
const key = {
  whipUrl: "/ingest/s-12345678901234567890123456789012/whip",
  user: "test-user",
  key: "private-test-key",
} as Publishing;
const source = { getTracks: () => [] } as unknown as MediaStream;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function negotiation() {
  vi.stubGlobal("RTCPeerConnection", Peer);
  const fetch = vi.fn(async () => ({
    status: 201,
    headers: new Headers({ Location: key.whipUrl + "/abc" }),
    text: async () => "test answer",
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("does not report publishing when WHIP accepts SDP but ICE is still connecting", async () => {
  negotiation();
  let resolved = false;
  const pending = publishWhip(source, key, () => {}).then((v) => {
    resolved = true;
    return v;
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(resolved).toBe(false);
  Peer.last.transition("connected");
  const session = await pending;
  expect(resolved).toBe(true);
  await session.close();
});
it("cleans up the exact remote session when ICE permanently fails", async () => {
  const fetch = negotiation();
  const pending = publishWhip(source, key, () => {});
  const rejected = expect(pending).rejects.toThrow(/ICE|connection|network/i);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  Peer.last.transition("failed");
  await rejected;
  expect(Peer.last.close).toHaveBeenCalled();
  expect(
    fetch.mock.calls.some(
      (call) =>
        (call as unknown as [string, RequestInit])[1]?.method === "DELETE",
    ),
  ).toBe(true);
});
it("rejects stalled ICE at the deadline and deletes the accepted WHIP resource", async () => {
  vi.useFakeTimers();
  const fetch = negotiation();
  const pending = publishWhip(source, key, () => {});
  const rejected = expect(pending).rejects.toThrow(/timed out.*ICE/);
  await vi.advanceTimersByTimeAsync(20001);
  await rejected;
  expect(Peer.last.close).toHaveBeenCalled();
  expect(
    fetch.mock.calls.some(
      (call) =>
        (call as unknown as [string, RequestInit])[1]?.method === "DELETE",
    ),
  ).toBe(true);
});
it("cleans an accepted session when the owner cancels during connection", async () => {
  const fetch = negotiation(),
    controller = new AbortController();
  const pending = publishWhip(source, key, () => {}, controller.signal);
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  controller.abort();
  await rejected;
  expect(
    fetch.mock.calls.some(
      (call) =>
        (call as unknown as [string, RequestInit])[1]?.method === "DELETE",
    ),
  ).toBe(true);
});

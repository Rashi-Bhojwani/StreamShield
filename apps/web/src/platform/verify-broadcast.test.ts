import { it, expect, vi, afterEach } from "vitest";
import { verifyBroadcast } from "./verify-broadcast";
const stream = {
  id: "s-test",
  title: "test",
  status: "starting",
  publisher: "online",
  hls: "available",
  reason: "verified_manifest",
  checkedAt: new Date().toISOString(),
  playbackUrl: "/hls/test/index.m3u8",
  tracks: ["H264", "Opus"],
  lifecycle: "ready",
  broadcastState: "PUBLISHING",
};
afterEach(() => vi.useRealTimers());
it("requires verified LIVE rather than a connected publisher, and tolerates brief API failover", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockResolvedValueOnce(stream)
    .mockRejectedValueOnce(new Error("failover"))
    .mockResolvedValueOnce({
      ...stream,
      status: "live",
      broadcastState: "LIVE",
    });
  const pending = verifyBroadcast(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(read).toHaveBeenCalledTimes(3);
});
it("bounds verification and leaves cleanup to the caller on timeout", async () => {
  vi.useFakeTimers();
  // Native AbortSignal.timeout uses a real clock; explicitly trigger its signal.
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const read = vi.fn().mockResolvedValue(stream);
  const pending = verifyBroadcast(read, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow(
    /LIVE verification timed out/,
  );
  await vi.advanceTimersByTimeAsync(1000);
  deadline.abort();
  await rejected;
  vi.restoreAllMocks();
});
it("does not wait indefinitely after authoritative failure", async () => {
  await expect(
    verifyBroadcast(
      async () => ({ ...stream, broadcastState: "FAILED" }),
      new AbortController().signal,
    ),
  ).rejects.toThrow(/verification failed/);
});

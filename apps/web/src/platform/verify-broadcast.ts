import { streamSchema } from "@streamshield/shared";

// A connected peer is insufficient: require media progress + delivery from the server.
export async function verifyBroadcast(
  read: (signal: AbortSignal) => Promise<unknown>,
  cancelled: AbortSignal,
) {
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(45000)]);
  let last = "No media observation received";
  try {
    while (!signal.aborted) {
      try {
        const stream = streamSchema.parse(await read(signal));
        last = stream.reason;
        if (stream.status === "live" && stream.broadcastState === "LIVE")
          return;
        if (stream.lifecycle === "ended" || stream.broadcastState === "FAILED")
          throw new Error("Broadcast verification failed: " + last);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Broadcast verification failed:")
        )
          throw error;
        // Brief API failover is recoverable within the same bounded deadline.
        last = "Media status is temporarily unavailable";
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Verification cancelled or timed out."));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  throw new Error(
    cancelled.aborted
      ? "Publishing cancelled."
      : "Media connection opened, but server LIVE verification timed out. " +
          last +
          ". Check relay/origin/edge health. This attempt will be stopped; create a new broadcast to retry.",
  );
}

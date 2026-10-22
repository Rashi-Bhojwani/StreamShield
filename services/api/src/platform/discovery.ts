import type { Server } from "socket.io";
import type { Resources } from "./resources.js";
import type { Catalog } from "./catalog.js";
import { streamSelect } from "./catalog.js";

// One bounded scanner per database; discovery does not depend on a browser polling it.
export function startDiscoveryObserver(
  r: Resources,
  catalog: Catalog,
  io: Server,
) {
  let stopped = false;
  let running = false;
  catalog.setNotify((event) => io.emit("discovery:v1", event));
  catalog.setModerationNotify((event) =>
    io.to("stream:" + event.streamId).emit("chat:moderated", event),
  );
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const db = await r.db.connect();
    let locked = false;
    try {
      locked = (
        await db.query("SELECT pg_try_advisory_lock(52008001) AS locked")
      ).rows[0].locked;
      if (!locked) return;
      const rows = (
        await db.query(
          streamSelect +
            " WHERE s.lifecycle='ready' ORDER BY s.dynamic_checked_at NULLS FIRST,s.created_at LIMIT 32",
        )
      ).rows;
      for (let i = 0; i < rows.length; i += 4) {
        if (stopped) break;
        await Promise.allSettled(
          rows.slice(i, i + 4).map((row) => catalog.observe(row)),
        );
      }
    } finally {
      if (locked) await db.query("SELECT pg_advisory_unlock(52008001)");
      db.release();
      running = false;
    }
  };
  const timer = setInterval(
    () =>
      void tick().catch(() => {
        running = false;
      }),
    2000,
  );
  timer.unref();
  void tick().catch(() => {
    running = false;
  });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

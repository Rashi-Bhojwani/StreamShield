import type { Server } from "socket.io";
import { z } from "zod";
import type { Resources } from "../platform/resources.js";
import { session, rate } from "../platform/security.js";
export function attachMonitoring(io: Server, r: Resources) {
  const channel = "monitoring:" + String(process.env.REDIS_DB || 0);
  const envelope = z
    .object({
      version: z.literal(1),
      sequence: z.string().regex(/^\d+$/),
      at: z.iso.datetime(),
      kind: z.literal("snapshot_changed"),
    })
    .strict();
  let delivering = false;
  void r.sub
    .subscribe(channel, (raw) => {
      if (delivering) return;
      const parsed = envelope.safeParse(
        (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })(),
      );
      if (!parsed.success) return;
      delivering = true;
      void (async () => {
        for (const socket of io.sockets.sockets.values()) {
          if (!socket.rooms.has("monitoring:administrators")) continue;
          try {
            const auth = await session(r, socket.handshake.headers.cookie);
            if (auth?.user.role === "administrator")
              socket.emit("monitoring:v1", parsed.data);
            else {
              await socket.leave("monitoring:administrators");
              socket.emit("monitoring:denied");
            }
          } catch {
            socket.emit("monitoring:unavailable");
          }
        }
      })().finally(() => {
        delivering = false;
      });
    })
    .catch(() => {});
  io.on("connection", (socket) => {
    socket.on("monitoring:subscribe", async (ack: unknown) => {
      const reply = (ok: boolean) => {
        if (typeof ack === "function") ack({ ok });
      };
      try {
        await rate(r, "monitoring-subscribe:" + socket.id, 12, 60000);
        const auth = await session(r, socket.handshake.headers.cookie);
        if (auth?.user.role !== "administrator") {
          reply(false);
          return;
        }
        if (
          (io.sockets.adapter.rooms.get("monitoring:administrators")?.size ||
            0) >= 50
        ) {
          reply(false);
          return;
        }
        await socket.join("monitoring:administrators");
        reply(true);
      } catch {
        reply(false);
      }
    });
  });
}

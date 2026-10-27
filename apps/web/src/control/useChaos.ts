import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseChaosSnapshot } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { chaosReadiness } from "./chaos-readiness";
export function useChaos() {
  const { call } = useAuth(),
    [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const q = useQuery({
    queryKey: ["monitoring", "chaos"],
    queryFn: async () => {
      const raw = await call<unknown>("/monitoring/chaos");
      try {
        return {
          ...parseChaosSnapshot(raw),
          receivedAtMonotonic: performance.now(),
        };
      } catch {
        const error = new Error(
          "Controller response does not match the monitoring contract. Check service versions and timestamps.",
        );
        error.name = "InvalidChaosResponse";
        throw error;
      }
    },
    refetchInterval: (query) => (query.state.data?.activeId ? 1000 : 3000),
    retry: false,
  });
  const reason = chaosReadiness(
    q.data,
    q.error,
    q.data ? now - q.data.receivedAtMonotonic : 0,
  );
  const serverNow =
    Date.parse(q.data?.serverTime || q.data?.observedAt || "") +
    Math.max(0, q.data ? now - q.data.receivedAtMonotonic : 0);
  return { ...q, live: !reason, reason, serverNow };
}

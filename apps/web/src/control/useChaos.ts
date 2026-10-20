import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChaosSnapshot } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
export function useChaos() {
  const { call } = useAuth(),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const q = useQuery({
    queryKey: ["monitoring", "chaos"],
    queryFn: () => call<ChaosSnapshot>("/monitoring/chaos"),
    refetchInterval: 3000,
    retry: false,
  });
  return {
    ...q,
    live:
      !!q.data?.available &&
      !!q.data.observedAt &&
      now - Date.parse(q.data.observedAt) < 12000 &&
      !q.isError,
  };
}

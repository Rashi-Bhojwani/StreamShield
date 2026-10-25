import { useQuery } from "@tanstack/react-query";
import type { HealingSnapshot } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import { config } from "../config";
export function useRecovery() {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "healing"],
    queryFn: () => call<HealingSnapshot>("/monitoring/healing"),
    refetchInterval: config.VITE_STATUS_POLL_MS,
    retry: false,
  });
}

import { useQuery } from "@tanstack/react-query";
import type { Stream } from "@streamshield/shared";
import { platformRequest } from "../platform/request";
import { config } from "../config";
export type DemoChannel = Stream & {
  slot: number;
  viewers: number | null;
  viewerLabel: string;
};
export function useDemoChannels() {
  return useQuery({
    queryKey: ["demo-channels"],
    queryFn: () =>
      platformRequest<{ channels: DemoChannel[] }>("/demo/channels"),
    refetchInterval: config.VITE_STREAM_POLL_MS,
    retry: false,
  });
}

import { useQuery } from "@tanstack/react-query";
import { fetchStreams } from "../api";
import { config } from "../config";
export function useStreams() {
  return useQuery({
    queryKey: ["streams"],
    queryFn: ({ signal }) => fetchStreams(signal),
    refetchInterval: config.VITE_STREAM_POLL_MS,
  });
}

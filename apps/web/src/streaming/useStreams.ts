import { useQuery } from "@tanstack/react-query";
import { fetchStreams } from "../api";
import { config } from "../config";
export function useStreams(search = "", offset = 0) {
  return useQuery({
    queryKey: ["streams", search, offset],
    queryFn: ({ signal }) => fetchStreams(signal, search, offset),
    refetchInterval: config.VITE_STREAM_POLL_MS,
  });
}

import type { Stream } from "@streamshield/shared";
const labels = {
  live: "Source available",
  offline: "Offline",
  starting: "Connecting",
  unavailable: "Status unavailable",
};
export function StatusBadge({
  status,
}: {
  status: Stream["status"] | "unknown";
}) {
  return (
    <span className={"status-badge status-" + status}>
      <span className="status-dot" />
      {status === "unknown" ? "Status unknown" : labels[status]}
    </span>
  );
}

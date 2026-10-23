export const names = {
  start_stopped_service: "start",
  restart_unresponsive_service: "restart",
};
/** One Healer "Recovery transition" log line as a plain-English sentence. */
export function sentence(line) {
  const e = JSON.parse(line);
  if (e.msg !== "Recovery transition") return null;
  const at = new Date(e.time).toLocaleTimeString([], { hour12: false });
  const what = {
    SCHEDULED: `diagnosed ${e.component} (${e.reason}) → playbook ${e.playbook}`,
    EXECUTING: `${e.component}: playbook ${e.playbook} acting now`,
    VERIFYING: `${e.component}: action done, verifying real behaviour`,
    RETRY_WAIT: `${e.component}: verification window failed, bounded retry`,
    VERIFIED: `${e.component} verified healthy (${e.reason})`,
    ESCALATED: [
      "authority_or_dependency_symptom",
      "component_returned_without_healer_action",
    ].includes(e.reason)
      ? `${e.component} degraded by a failed dependency — no action on it; waits for the dependency`
      : `${e.component} ESCALATED to a human (${e.reason})`,
  }[e.state];
  return what ? `${at} Healer: ${what}` : null;
}

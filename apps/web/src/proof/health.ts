/** The shared health vocabulary: colour token + icon + label, never colour alone. */
export type HealthTone =
  | "healthy"
  | "degraded"
  | "failed"
  | "healing"
  | "recovered"
  | "escalated"
  | "unknown"
  | "injected";
export const tones: Record<
  HealthTone,
  { label: string; icon: string; meaning: string }
> = {
  healthy: { label: "Healthy", icon: "✓", meaning: "All probes passing" },
  degraded: {
    label: "Degraded / on backup",
    icon: "▲",
    meaning: "Slow, overloaded, or running on a redundant peer or standby",
  },
  failed: {
    label: "Failed",
    icon: "✕",
    meaning: "Threshold-confirmed failure",
  },
  healing: {
    label: "Healing",
    icon: "⟳",
    meaning: "Healer action executing or verifying",
  },
  recovered: {
    label: "Recovered",
    icon: "✓✓",
    meaning: "Independently verified after a repair",
  },
  escalated: {
    label: "Escalated",
    icon: "!",
    meaning: "Healer refused or gave up safely; a human must act",
  },
  unknown: {
    label: "Unknown / no data",
    icon: "?",
    meaning: "No fresh evidence; never shown as green",
  },
  injected: {
    label: "Fault injected",
    icon: "ϟ",
    meaning: "The moment Chaos injected the fault",
  },
};
export const toneVar = (t: HealthTone) => `var(--state-${t})`;

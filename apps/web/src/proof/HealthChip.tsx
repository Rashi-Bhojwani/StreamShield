import { tones, type HealthTone } from "./health";
export function HealthChip({
  tone,
  label,
  title,
}: {
  tone: HealthTone;
  label?: string;
  title?: string;
}) {
  return (
    <span
      className={"health-chip tone-" + tone}
      data-tone={tone}
      title={title || tones[tone].meaning}
    >
      <span aria-hidden="true">{tones[tone].icon}</span>
      {label ?? tones[tone].label}
    </span>
  );
}

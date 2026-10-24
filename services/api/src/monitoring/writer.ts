/** One writer, at most one waiting snapshot. Probe callers never await SQL. */
export class CoalescingWriter<T> {
  private pending: T | undefined;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private write: (value: T) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {}
  offer(value: T) {
    if (this.stopped) return;
    this.pending = value;
    this.start();
  }
  private start() {
    if (!this.running && !this.stopped && this.pending !== undefined)
      this.running = this.drain().finally(() => {
        this.running = null;
        // An offer can arrive after drain exits but before this finalizer runs.
        this.start();
      });
  }
  private async drain() {
    while (this.pending !== undefined && !this.stopped) {
      const value = this.pending;
      this.pending = undefined;
      try {
        await this.write(value);
      } catch (error) {
        this.failed(error);
      }
    }
  }
  async idle() {
    while (this.running) await this.running;
  }
  stop() {
    this.stopped = true;
    this.pending = undefined;
  }
}

import type { ComponentObservation } from "@streamshield/shared";
/** A persisted failure episode is acknowledged by identity, not by a moving probe object. */
export function unrecordedFailures(
  captured: Map<string, ComponentObservation>,
  recorded: Map<string, string>,
) {
  return new Map(
    [...captured].filter(
      ([id, c]) => c.confirmedAt && recorded.get(id) !== c.confirmedAt,
    ),
  );
}
export function acknowledgeFailures(
  pending: Map<string, ComponentObservation>,
  captured: Map<string, ComponentObservation>,
  recorded: Map<string, string>,
) {
  for (const [id, c] of captured)
    if (c.confirmedAt) {
      recorded.set(id, c.confirmedAt);
      if (pending.get(id)?.confirmedAt === c.confirmedAt) pending.delete(id);
    }
}

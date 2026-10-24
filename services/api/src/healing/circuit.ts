export class Circuit {
  state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  failures = 0;
  rejected = 0;
  requests = 0;
  lastSuccessAt: string | null = null;
  private until = 0;
  private busy = false;
  private successes = 0;
  private reopenCount = 0;
  constructor(
    private threshold: number,
    private resetMs: number,
    private random: () => number = Math.random,
  ) {}
  async execute<T>(read: () => Promise<T>, now?: number): Promise<T> {
    const clock = () => now ?? Date.now();
    if ((this.state === "OPEN" && clock() < this.until) || this.busy) {
      this.rejected++;
      throw new Error("circuit_open");
    }
    if (this.state === "OPEN") this.state = "HALF_OPEN";
    this.busy = true;
    this.requests++;
    try {
      const value = await read();
      this.lastSuccessAt = new Date().toISOString();
      if (this.state === "HALF_OPEN") {
        if (++this.successes >= 2) {
          this.state = "CLOSED";
          this.failures = 0;
          this.reopenCount = 0;
        }
      } else this.failures = 0;
      return value;
    } catch {
      this.successes = 0;
      if (++this.failures >= this.threshold || this.state === "HALF_OPEN") {
        this.state = "OPEN";
        const delay = Math.min(this.resetMs * 2 ** this.reopenCount, 60000);
        const jitter = this.reopenCount
          ? Math.floor(this.random() * this.resetMs * 0.25)
          : 0;
        this.until = clock() + Math.min(delay + jitter, 60000);
        this.reopenCount = Math.min(this.reopenCount + 1, 6);
      }
      throw new Error("dependency_unavailable");
    } finally {
      this.busy = false;
    }
  }
  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      rejected: this.rejected,
      requests: this.requests,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
}

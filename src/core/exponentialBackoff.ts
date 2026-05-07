/**
 * Exponential delay sequence for network / throttle recovery (caps at maxMs).
 */
export class ExponentialBackoff {
  private attempt = 0;

  constructor(
    readonly initialMs: number,
    readonly factor: number,
    readonly maxMs: number,
  ) {}

  /** Next delay in ms; first call uses initialMs. */
  nextDelayMs(): number {
    const raw = Math.floor(this.initialMs * Math.pow(this.factor, this.attempt));
    this.attempt += 1;
    return Math.min(raw, this.maxMs);
  }

  reset(): void {
    this.attempt = 0;
  }
}

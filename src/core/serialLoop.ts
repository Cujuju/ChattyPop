/** Runs `pass` one at a time; a kick during a pass runs one more pass right after it, so no request is lost. */
export class SerialLoop {
  private running = false;
  private again = false;

  constructor(private readonly pass: () => Promise<void>) {}

  /** A pass is running. */
  get busy(): boolean {
    return this.running;
  }

  /** Runs passes until no kick is left; resolves at once when a pass is already running. Rejects when a pass throws. */
  async kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }
}

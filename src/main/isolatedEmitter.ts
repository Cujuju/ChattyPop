// Main's event fan-outs. Node's EventEmitter stops at a throwing listener and throws into the emitter; this runs each isolated.
import { fanOut } from '@shared/fanOut';

/** Each event's listener arguments, by event name. */
type EventArgs<T> = { [K in keyof T]: unknown[] };
type AnyListener = (...args: never[]) => unknown;

/** Typed on/once/off; emit runs every listener isolated (fanOut): a throw or rejection goes to `listenerFailed`, never to others or the emitter. */
export class IsolatedEmitter<T extends EventArgs<T>> {
  /** Replaced, never mutated, so an emit runs the listeners it began with. */
  private readonly listeners = new Map<keyof T, readonly AnyListener[]>();

  constructor(private readonly listenerFailed: (event: string, err: unknown) => void) {}

  on<K extends keyof T>(event: K, fn: (...args: T[K]) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  once<K extends keyof T>(event: K, fn: (...args: T[K]) => unknown): this {
    const one = (...args: T[K]): unknown => {
      this.off(event, one);
      return fn(...args);
    };
    return this.on(event, one);
  }

  off<K extends keyof T>(event: K, fn: (...args: T[K]) => unknown): this {
    const list = this.listeners.get(event) ?? [];
    const at = list.lastIndexOf(fn);
    if (at >= 0) this.listeners.set(event, list.filter((_, i) => i !== at));
    return this;
  }

  protected emit<K extends keyof T>(event: K, ...args: T[K]): void {
    const listeners = (this.listeners.get(event) ?? []) as readonly ((...a: T[K]) => unknown)[];
    fanOut(listeners, args, (err) => this.listenerFailed(String(event), err));
  }
}

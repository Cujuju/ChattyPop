export interface FieldSelection { start: number; end: number }
export interface FieldSnapshot extends FieldSelection { text: string }

/** Draft edits undo together while typing consecutively; a pick/paste/cut is its own transaction. */
export class DraftFieldHistory {
  private snapshots: FieldSnapshot[];
  private index = 0;
  private typingEnd: number | null = null;
  private editedAt = 0;
  constructor(text = '') { this.snapshots = [{ text, start: text.length, end: text.length }]; }

  record(text: string, before: FieldSelection, after: FieldSelection, typing = false, now = Date.now()): void {
    const old = this.snapshots[this.index]!;
    if (old.text === text) return;
    const merge = typing && this.typingEnd === before.start && before.start === before.end && now - this.editedAt < 1_000;
    const next = { text, ...after };
    if (merge) this.snapshots[this.index] = next;
    else {
      Object.assign(old, before);
      this.snapshots.splice(this.index + 1);
      this.snapshots.push(next);
      this.index++;
      if (this.snapshots.length > 100) { this.snapshots.shift(); this.index--; }
    }
    this.typingEnd = typing ? after.end : null;
    this.editedAt = now;
  }

  undo(): FieldSnapshot | null {
    this.typingEnd = null;
    return this.index > 0 ? { ...this.snapshots[--this.index]! } : null;
  }
  redo(): FieldSnapshot | null {
    this.typingEnd = null;
    return this.index < this.snapshots.length - 1 ? { ...this.snapshots[++this.index]! } : null;
  }
}

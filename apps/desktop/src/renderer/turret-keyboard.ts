export type DriveIntent = {yaw: number; pitch: number; fine: boolean; session: string; sequence: number};
const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** One in-flight request, latest key state only. The Pi independently expires each drive lease. */
export class TurretKeyboard {
  private keys = new Set<string>();
  private session = '';
  private sequence = 0;
  private revision = 0;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private fine = false;
  private reverseYaw = false;
  private reversePitch = false;
  constructor(private send: (intent: DriveIntent) => Promise<unknown>, private fail: (error: unknown) => void) {}

  start(session: string) {
    this.stop(); this.session = session; this.sequence = 0;
    this.timer = setInterval(() => { if (this.keys.size) void this.flush(); }, 100);
  }
  stop() {
    this.session = ''; this.keys.clear(); this.revision++;
    clearInterval(this.timer); this.timer = undefined;
  }
  configure(fine: boolean, reverseYaw: boolean, reversePitch: boolean) {
    this.fine = fine; this.reverseYaw = reverseYaw; this.reversePitch = reversePitch;
  }
  key(key: string, down: boolean): boolean {
    if (!this.session || !arrows.has(key)) return false;
    if (this.keys.has(key) === down) return true; // Ignore operating-system key repeat.
    if (down) this.keys.add(key); else this.keys.delete(key);
    this.revision++; void this.flush(); return true;
  }
  private async flush() {
    if (!this.session || this.pending) return;
    const session = this.session, revision = this.revision;
    const yaw = Number(this.keys.has('ArrowRight')) - Number(this.keys.has('ArrowLeft'));
    const pitch = Number(this.keys.has('ArrowUp')) - Number(this.keys.has('ArrowDown'));
    this.pending = true;
    try {
      await this.send({session, sequence: ++this.sequence, fine: this.fine,
        yaw: yaw * (this.reverseYaw ? -1 : 1), pitch: pitch * (this.reversePitch ? -1 : 1)});
    } catch (error) {
      if (this.session === session) { this.stop(); this.fail(error); }
    } finally {
      this.pending = false;
      if (this.session && (this.session !== session || revision !== this.revision)) void this.flush();
    }
  }
}

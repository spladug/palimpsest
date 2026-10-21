// Simulation time is measured in years (fractional). Processes run at their own
// rates; discrete happenings go on the event queue.

export interface Process<W> {
  name: string;
  /** Years between runs. */
  interval: number;
  run(world: W, now: number, dt: number): void;
}

export interface SimEvent<W> {
  time: number;
  name: string;
  fire(world: W, clock: Clock<W>): void;
}

interface ScheduledProcess<W> {
  process: Process<W>;
  next: number;
  last: number;
}

export class Clock<W> {
  now: number;
  private processes: ScheduledProcess<W>[] = [];
  private events: SimEvent<W>[] = [];
  private seq = 0;
  private order = new Map<SimEvent<W>, number>();

  constructor(start: number) {
    this.now = start;
  }

  addProcess(process: Process<W>, firstRun = this.now): void {
    this.processes.push({ process, next: firstRun, last: this.now });
  }

  schedule(event: SimEvent<W>): void {
    this.order.set(event, this.seq++);
    this.events.push(event);
    // Earliest last, so pop() gives the next event; ties keep insertion order.
    this.events.sort((a, b) => b.time - a.time || this.order.get(b)! - this.order.get(a)!);
  }

  get pendingEvents(): readonly SimEvent<W>[] {
    return this.events;
  }

  /** Advance to `until`, running every process and event that falls due, in time order. */
  advance(world: W, until: number): void {
    for (;;) {
      const nextEvent = this.events.length ? this.events[this.events.length - 1].time : Infinity;
      let nextProc: ScheduledProcess<W> | null = null;
      for (const p of this.processes) {
        if (!nextProc || p.next < nextProc.next) nextProc = p;
      }
      const nextProcTime = nextProc ? nextProc.next : Infinity;
      const t = Math.min(nextEvent, nextProcTime);
      if (t > until) break;
      this.now = t;
      if (nextEvent <= nextProcTime) {
        const ev = this.events.pop()!;
        this.order.delete(ev);
        ev.fire(world, this);
      } else if (nextProc) {
        nextProc.process.run(world, t, t - nextProc.last);
        nextProc.last = t;
        nextProc.next = t + nextProc.process.interval;
      }
    }
    this.now = until;
  }
}

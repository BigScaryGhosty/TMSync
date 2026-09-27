import type { ParsedMedia } from "@tmsync/shared";
import type { HistoryCheckpoint, WatchEvent } from "./types";

function newSessionId(): string {
  // getRandomValues also works on HTTP pages, where randomUUID may be unavailable.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface HistoryVideo {
  currentTime: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  playbackRate: number;
}

/** Content-owned observation only. Cumulative checkpoints make retransmission idempotent. */
export class HistoryRecorder {
  sessionId = newSessionId();
  private sequence = 0;
  private watchedSeconds = 0;
  private playing = false;
  private started = false;
  private terminal = false;
  private completed = false;
  private previous?: { time: number; position: number; rate: number };
  private lastPersist = 0;

  constructor(
    private readonly video: HistoryVideo,
    private readonly media: ParsedMedia,
    private readonly sourceHost: string,
    private readonly threshold: number,
    private readonly send: (checkpoint: HistoryCheckpoint) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.playing) return;
    if (this.terminal) {
      this.sessionId = newSessionId();
      this.sequence = 0;
      this.watchedSeconds = 0;
      this.completed = false;
      this.terminal = false;
    }
    this.started = true;
    this.playing = true;
    this.previous = undefined;
    this.sample();
    this.emit("start");
  }

  pause(): void {
    if (!this.playing || this.video.seeking) return;
    this.sample();
    this.playing = false;
    this.previous = undefined;
    this.emit("pause");
    if (!this.completed && this.progress() >= this.threshold * 100) {
      this.completed = true;
      this.emit("stop");
    }
  }

  /** Drop the interval around a seek, including seeks smaller than a checkpoint. */
  discontinuity(): void {
    this.previous = undefined;
  }

  tick(): void {
    if (!this.started || this.terminal) return;
    this.sample();
    if (!this.completed && this.progress() >= this.threshold * 100) {
      this.completed = true;
      this.emit("stop");
    } else if (this.playing && this.now() - this.lastPersist >= 5000) {
      this.emit("progress");
    }
  }

  stop(ended = false): void {
    if (!this.started || this.terminal) return;
    this.sample();
    this.playing = false;
    this.terminal = true;
    this.previous = undefined;
    this.emit("stop", ended ? 100 : this.progress());
  }

  private sample(): void {
    const time = this.now();
    const position = this.video.currentTime;
    const prior = this.previous;
    if (prior && this.playing && !this.video.seeking) {
      const elapsed = (time - prior.time) / 1000;
      const advance = position - prior.position;
      // Count wall time supported by actual advancement. Stalls add nothing;
      // long suspended gaps and implausible jumps are conservatively discarded.
      if (
        elapsed > 0 &&
        elapsed <= 10 &&
        advance > 0 &&
        prior.rate > 0 &&
        advance <= elapsed * prior.rate + 0.5
      ) {
        this.watchedSeconds += Math.min(elapsed, advance / prior.rate);
      }
    }
    this.previous = this.video.seeking
      ? undefined
      : { time, position, rate: this.video.playbackRate };
  }

  private progress(): number {
    return Number.isFinite(this.video.duration) && this.video.duration > 0
      ? Math.min(100, Math.max(0, (this.video.currentTime / this.video.duration) * 100))
      : 0;
  }

  private emit(type: WatchEvent["type"], progress = this.progress()): void {
    this.lastPersist = this.now();
    this.send({
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      media: this.media,
      type,
      occurredAt: this.lastPersist,
      progress,
      positionSeconds: Number.isFinite(this.video.currentTime) ? this.video.currentTime : undefined,
      durationSeconds:
        Number.isFinite(this.video.duration) && this.video.duration > 0
          ? this.video.duration
          : undefined,
      watchedSeconds: this.watchedSeconds,
      watchedThreshold: this.threshold,
      sourceHost: this.sourceHost,
    });
  }
}

const VIDEO_EVENTS = [
  "play",
  "pause",
  "ended",
  "seeking",
  "seeked",
  "ratechange",
  "timeupdate",
  "loadstart",
] as const;
export type PlaybackEvent = (typeof VIDEO_EVENTS)[number] | "pagehide";
type Observer = (event: PlaybackEvent) => void;

/** One DOM listener set per video, with independently removable local/tracker observers. */
export class PlaybackEvents {
  private readonly videos = new Map<
    HTMLVideoElement,
    {
      observers: Set<Observer>;
      abort: AbortController;
    }
  >();

  constructor(private readonly onLoadStart: () => void) {}

  observe(video: HTMLVideoElement, observer: Observer, signal: AbortSignal): void {
    if (signal.aborted) return;
    let entry = this.videos.get(video);
    if (!entry) {
      const observers = new Set<Observer>();
      const abort = new AbortController();
      entry = { observers, abort };
      this.videos.set(video, entry);
      const dispatch = (event: PlaybackEvent) => {
        if (event === "loadstart") this.onLoadStart();
        for (const notify of observers) notify(event);
      };
      for (const event of VIDEO_EVENTS) {
        video.addEventListener(event, () => dispatch(event), { signal: abort.signal });
      }
      window.addEventListener("pagehide", () => dispatch("pagehide"), { signal: abort.signal });
    }
    const { observers, abort } = entry;
    observers.add(observer);
    signal.addEventListener(
      "abort",
      () => {
        observers.delete(observer);
        if (!observers.size) {
          abort.abort();
          this.videos.delete(video);
        }
      },
      { once: true },
    );
  }
}

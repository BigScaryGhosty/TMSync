import type { HistoryCheckpoint } from "@/lib/history/types";
import { sendMessage } from "@/messaging";
import { type ParsedMedia, type Recipe, RecipeSchema } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { SessionManager } from "./session";

const { message } = vi.hoisted(() => ({
  message: vi.fn<(name: string, data?: unknown) => Promise<unknown>>(),
}));
vi.mock("@/messaging", () => ({ sendMessage: message, onMessage: vi.fn(() => () => {}) }));

const media: ParsedMedia = { mediaType: "movie", title: "Offline Movie" };
describe("SessionManager local history integration", () => {
  let manager: {
    startSession(video: HTMLVideoElement, media: ParsedMedia): void;
    teardownSession(): void;
    history: { sessionId: string } | null;
  };
  let video: HTMLVideoElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    message.mockResolvedValue({ ok: false, resolved: false, reason: "not_connected" });
    manager = new SessionManager({} as ContentScriptContext, []) as unknown as typeof manager;
    video = document.createElement("video");
    Object.defineProperties(video, {
      duration: { value: 100 },
      paused: { value: false, writable: true },
      ended: { value: false, writable: true },
      currentTime: { value: 0, writable: true },
    });
  });
  afterEach(() => {
    manager.teardownSession();
    vi.useRealTimers();
  });

  it("records without a tracker connection and keeps the existing scrobble phase", async () => {
    manager.startSession(video, media);
    expect(sendMessage).toHaveBeenCalledWith(
      "recordHistory",
      expect.objectContaining({ type: "start", media }),
    );
    await vi.advanceTimersByTimeAsync(800);
    expect(sendMessage).toHaveBeenCalledWith(
      "scrobble",
      expect.objectContaining({ action: "start", media }),
    );
    await vi.advanceTimersByTimeAsync(4200);
    video.currentTime = 5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(sendMessage).toHaveBeenCalledWith(
      "recordHistory",
      expect.objectContaining({ type: "progress", watchedSeconds: 5 }),
    );
    video.dispatchEvent(new Event("pause"));
    expect(sendMessage).toHaveBeenCalledWith(
      "recordHistory",
      expect.objectContaining({ type: "pause" }),
    );
  });

  it("preserves the outgoing period on replacement and page exit", () => {
    manager.startSession(video, media);
    const previous = manager.history?.sessionId;
    manager.startSession(video, { ...media, title: "Next Movie" });
    expect(sendMessage).toHaveBeenCalledWith(
      "recordHistory",
      expect.objectContaining({ sessionId: previous, type: "stop" }),
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(sendMessage).toHaveBeenCalledWith(
      "recordHistory",
      expect.objectContaining({ type: "stop", media: { ...media, title: "Next Movie" } }),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function recipe(manual = false): Recipe {
  return RecipeSchema.parse({
    id: "history-test",
    name: "History test",
    schemaVersion: 4,
    match: { urlPattern: ".*" },
    mediaType: "movie",
    ...(manual ? {} : { extract: { title: { source: "title" } } }),
  });
}
function makeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    duration: { value: 100, configurable: true },
    paused: { value: false, configurable: true },
    ended: { value: false, configurable: true },
    currentTime: { value: 0, writable: true },
    playbackRate: { value: 1, writable: true },
  });
  return video;
}
const historyEvents = () =>
  message.mock.calls
    .filter(([name]) => name === "recordHistory")
    .map(([, data]) => data as HistoryCheckpoint);
const scrobbles = () =>
  message.mock.calls
    .filter(([name]) => name === "scrobble")
    .map(([, data]) => data as { action: string; media: ParsedMedia });

describe("local observation before tracker preflight", () => {
  let manager: {
    start(): void;
    reconcile(): Promise<void>;
    ensureHistory(): void;
    ensurePlaying(): Promise<void>;
    teardownSession(): void;
    controller: unknown;
  };
  let video: HTMLVideoElement;
  let resolution: ReturnType<
    typeof deferred<{ resolved: boolean; title?: string; reason?: string }>
  >;
  let invalidations: Array<() => void>;

  const createManager = (recipes = [recipe()]) => {
    manager = new SessionManager(
      {
        onInvalidated: (fn: () => void) => invalidations.push(fn),
        addEventListener: (target: EventTarget, event: string, listener: EventListener) => {
          target.addEventListener(event, listener);
          invalidations.push(() => target.removeEventListener(event, listener));
        },
        setInterval: (handler: () => void, ms: number) => {
          const timer = setInterval(handler, ms);
          invalidations.push(() => clearInterval(timer));
          return timer;
        },
      } as unknown as ContentScriptContext,
      recipes,
    ) as unknown as typeof manager;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    document.title = media.title;
    document.body.innerHTML = "";
    invalidations = [];
    video = makeVideo();
    document.body.append(video);
    resolution = deferred();
    message.mockImplementation(async (name) => {
      if (name === "resolveMedia") return resolution.promise;
      if (name === "getManualMedia") return media;
      if (name === "getTabMedia") return null;
      if (name === "scrobble") return { ok: true, resolved: true };
      return true;
    });
    createManager();
  });
  afterEach(() => {
    manager.teardownSession();
    for (const invalidate of invalidations) invalidate();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });
  const progress = async (position: number) => {
    await vi.advanceTimersByTimeAsync(5000);
    video.currentTime = position;
    video.dispatchEvent(new Event("timeupdate"));
  };

  it.each([false, true])(
    "starts history before resolution, without starting trackers (manual=%s)",
    async (manual) => {
      createManager([recipe(manual)]);
      const pending = manager.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(message).toHaveBeenCalledWith("resolveMedia", expect.anything());
      expect(historyEvents()).toEqual([expect.objectContaining({ type: "start", media })]);
      expect(manager.controller).toBeNull();
      await progress(5);
      expect(historyEvents().at(-1)).toMatchObject({ type: "progress", watchedSeconds: 5 });
      expect(scrobbles()).toEqual([]);
      expect(message.mock.calls.some(([name]) => name === "updateProgress")).toBe(false);
      resolution.resolve({ resolved: true, title: media.title });
      await pending;
      expect(scrobbles()).toEqual([]); // the upstream controller still debounces its start
      await vi.advanceTimersByTimeAsync(800);
      expect(scrobbles()).toEqual([expect.objectContaining({ action: "start", media })]);
      expect(historyEvents().filter((e) => e.type === "start")).toHaveLength(1);
      Object.defineProperty(video, "paused", { value: true });
      video.dispatchEvent(new Event("pause"));
      await vi.advanceTimersByTimeAsync(800);
      expect(scrobbles().at(-1)?.action).toBe("pause");
      video.currentTime = 100;
      video.dispatchEvent(new Event("ended"));
      expect(scrobbles().at(-1)?.action).toBe("stop");
    },
  );

  it("does not bypass pending preflight or duplicate listeners on repeated ensure/reconcile", async () => {
    const listeners = vi.spyOn(video, "addEventListener");
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const id = historyEvents()[0]?.sessionId;
    for (let i = 0; i < 3; i++) {
      manager.ensureHistory();
      await manager.reconcile();
      await manager.ensurePlaying();
      video.dispatchEvent(new Event("play"));
    }
    await progress(5);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: media.title });
    await pending;
    for (let i = 0; i < 3; i++) await manager.reconcile();
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles()).toHaveLength(1);
    expect(historyEvents().filter((e) => e.type === "start")).toHaveLength(1);
    expect(new Set(historyEvents().map((e) => e.sessionId))).toEqual(new Set([id]));
    for (const type of [
      "play",
      "pause",
      "ended",
      "seeking",
      "seeked",
      "ratechange",
      "timeupdate",
      "loadstart",
    ]) {
      expect(listeners.mock.calls.filter(([event]) => event === type)).toHaveLength(1);
    }
  });

  it.each(["not_connected", "unresolved"])(
    "retains local recording when resolution returns %s",
    async (reason) => {
      const pending = manager.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      resolution.resolve({ resolved: false, reason });
      await pending;
      await progress(5);
      expect(historyEvents().at(-1)).toMatchObject({ watchedSeconds: 5, type: "progress" });
      expect(scrobbles()[0]?.action).toBe("start");
    },
  );

  it("retains local recording when the resolution request rejects offline", async () => {
    const pending = manager.reconcile();
    const failed = expect(pending).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(0);
    resolution.reject(new Error("offline"));
    await failed;
    await progress(5);
    expect(historyEvents().at(-1)).toMatchObject({ type: "progress", watchedSeconds: 5 });
    expect(scrobbles()).toEqual([]);
  });

  it("waits for the rest of badge preflight after resolution", async () => {
    const standing = deferred<unknown[]>();
    const send = message.getMockImplementation();
    message.mockImplementation(async (name, data) =>
      name === "getWatchStanding" ? standing.promise : send?.(name, data),
    );
    const anime = recipe();
    anime.mediaType = "show";
    anime.tracker = "anilist";
    anime.extract = {
      title: { source: "title" },
      episode: { source: "title", regex: "(1)", transforms: ["toInt"] },
    };
    document.title = "Anime 1";
    createManager([anime]);
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    resolution.resolve({ resolved: true, title: "Anime" });
    await vi.advanceTimersByTimeAsync(0);
    expect(message).toHaveBeenCalledWith("getWatchStanding", {});
    await manager.reconcile();
    await progress(5);
    expect(scrobbles()).toEqual([]);
    standing.resolve([]);
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles()[0]?.action).toBe("start");
  });

  it("closes a replaced local player without stopping the tracker before its normal stage", async () => {
    resolution.resolve({ resolved: true, title: media.title });
    await manager.reconcile();
    await vi.advanceTimersByTimeAsync(800);
    const first = historyEvents()[0]?.sessionId;
    const oldVideo = video;
    video = makeVideo();
    oldVideo.replaceWith(video);
    document.title = "Next Movie";
    resolution = deferred();
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(historyEvents().filter((e) => e.sessionId === first && e.type === "stop")).toHaveLength(
      1,
    );
    expect(historyEvents().at(-1)).toMatchObject({ type: "start", media: { title: "Next Movie" } });
    expect(scrobbles().map((s) => s.action)).toEqual(["start"]);
    const count = historyEvents().length;
    oldVideo.dispatchEvent(new Event("pause"));
    expect(historyEvents()).toHaveLength(count);
    resolution.resolve({ resolved: true, title: "Next Movie" });
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles().map((s) => s.action)).toEqual(["start", "stop", "start"]);
  });

  it("ignores an old SPA resolution while a new media preflight is pending", async () => {
    const oldResolution = resolution;
    const oldFlow = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    document.title = "Next Movie";
    resolution = deferred();
    const newFlow = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    oldResolution.resolve({ resolved: true, title: media.title });
    await oldFlow;
    await progress(5);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: "Next Movie" });
    await newFlow;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles()).toEqual([
      expect.objectContaining({ media: { mediaType: "movie", title: "Next Movie" } }),
    ]);
    expect(historyEvents().filter((e) => e.type === "start")).toHaveLength(2);
  });

  it("observes a video discovered while resolution is pending without triggering trackers", async () => {
    video.remove();
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    // happy-dom delivers MutationObserver callbacks on its own real timer queue.
    vi.useRealTimers();
    document.body.append(video);
    await vi.waitFor(() => expect(historyEvents()[0]?.type).toBe("start"));
    vi.useFakeTimers();
    await progress(5);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: media.title });
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles()[0]?.action).toBe("start");
  });

  it("closes a history-only period on pagehide and prevents reattachment after teardown", async () => {
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("pagehide"));
    manager.teardownSession();
    expect(historyEvents().filter((e) => e.type === "stop")).toHaveLength(1);
    const count = historyEvents().length;
    video.dispatchEvent(new Event("play"));
    resolution.resolve({ resolved: true, title: media.title });
    await pending;
    await progress(5);
    expect(historyEvents()).toHaveLength(count);
    expect(scrobbles()).toEqual([]);
  });

  it("routes pause, seek, rate changes and ended to history while trackers are pending", async () => {
    const pending = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    await progress(5);
    video.dispatchEvent(new Event("seeking"));
    video.currentTime = 50;
    video.dispatchEvent(new Event("seeked"));
    video.playbackRate = 2;
    video.dispatchEvent(new Event("ratechange"));
    await progress(60);
    await progress(70);
    video.dispatchEvent(new Event("pause"));
    expect(historyEvents().at(-1)).toMatchObject({ type: "pause", watchedSeconds: 10 });
    video.dispatchEvent(new Event("play"));
    Object.defineProperty(video, "ended", { value: true });
    video.dispatchEvent(new Event("ended"));
    expect(historyEvents().at(-1)).toMatchObject({ type: "stop", progress: 100 });
    expect(new Set(historyEvents().map((e) => e.sessionId)).size).toBe(1);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: media.title });
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles()).toEqual([]);
  });

  it("starts history on captured play without bypassing the pending normal reconcile", async () => {
    Object.defineProperty(video, "paused", { value: true });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(historyEvents()).toEqual([]);
    Object.defineProperty(video, "paused", { value: false });
    video.dispatchEvent(new Event("play"));
    await progress(5);
    expect(historyEvents().map((e) => e.type)).toEqual(["start", "progress"]);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: media.title });
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles().map((s) => s.action)).toEqual(["start"]);
  });

  it("preserves the existing published-media path used by player iframes", async () => {
    createManager([]);
    const send = message.getMockImplementation();
    message.mockImplementation(async (name, data) =>
      name === "getTabMedia"
        ? {
            media,
            tracker: "trakt",
            watchedThreshold: 0.8,
            videoSelector: "video",
            frame: "iframe",
          }
        : send?.(name, data),
    );
    await manager.reconcile();
    expect(historyEvents()[0]).toMatchObject({ type: "start", media });
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles().map((s) => s.action)).toEqual(["start"]);
    expect(message.mock.calls.some(([name]) => name === "resolveMedia")).toBe(false);
  });

  it("does not let a stale same-media preflight unlock a replacement preflight", async () => {
    const oldResolution = resolution;
    const oldFlow = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    manager.teardownSession();
    resolution = deferred();
    const newFlow = manager.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    oldResolution.resolve({ resolved: true, title: media.title });
    await oldFlow;
    await progress(5);
    expect(scrobbles()).toEqual([]);
    resolution.resolve({ resolved: true, title: media.title });
    await newFlow;
    await vi.advanceTimersByTimeAsync(800);
    expect(scrobbles().map((s) => s.action)).toEqual(["start"]);
  });
});

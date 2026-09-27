import { sendMessage } from "@/messaging";
import type { ParsedMedia } from "@tmsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { SessionManager } from "./session";

vi.mock("@/messaging", () => ({
  sendMessage: vi.fn(async () => ({ ok: false, resolved: false, reason: "not_connected" })),
  onMessage: vi.fn(),
}));

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

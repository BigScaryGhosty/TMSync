import { describe, expect, it } from "vitest";
import { HistoryRecorder, type HistoryVideo } from "./recorder";
import type { HistoryCheckpoint } from "./types";

function setup() {
  let now = 1000;
  const video: HistoryVideo = {
    currentTime: 0,
    duration: 100,
    paused: false,
    seeking: false,
    playbackRate: 1,
  };
  const events: HistoryCheckpoint[] = [];
  const recorder = new HistoryRecorder(
    video,
    { mediaType: "movie", title: "Movie" },
    "example.test",
    0.8,
    (e) => events.push(e),
    () => now,
  );
  const tick = (seconds: number, advance = seconds) => {
    now += seconds * 1000;
    video.currentTime += advance;
    recorder.tick();
  };
  return { video, events, recorder, tick };
}

describe("history playback observation", () => {
  it("commits a threshold pause and treats ended like the existing controller", () => {
    const { recorder, video, events } = setup();
    recorder.start();
    video.currentTime = 80;
    recorder.pause();
    expect(events.slice(-2).map((e) => e.type)).toEqual(["pause", "stop"]);
    recorder.stop(true);
    expect(events.at(-1)?.progress).toBe(100);
  });
  it("records checkpoints every five seconds and deduplicates repeated events", () => {
    const { recorder, tick, events } = setup();
    recorder.start();
    recorder.start();
    for (let i = 0; i < 10; i++) {
      tick(0.5);
      recorder.tick();
    }
    recorder.pause();
    recorder.pause();
    expect(events.map((e) => e.type)).toEqual(["start", "progress", "pause"]);
    expect(events.at(-1)?.watchedSeconds).toBe(5);
  });

  it("does not count seeks, stalled playback, pause gaps or suspended time", () => {
    const { recorder, tick, video, events } = setup();
    recorder.start();
    tick(5);
    recorder.discontinuity();
    video.currentTime = 60;
    tick(1, 0);
    tick(5, 0);
    recorder.pause();
    tick(100, 0);
    recorder.start();
    tick(5);
    tick(100);
    recorder.stop();
    expect(events.at(-1)?.watchedSeconds).toBe(10);
  });

  it("rejects unannounced jumps and counts wall time at altered playback speeds", () => {
    const { recorder, tick, video, events } = setup();
    recorder.start();
    tick(1, 50);
    video.playbackRate = 2;
    recorder.discontinuity();
    tick(1, 0);
    tick(5, 10);
    recorder.stop();
    expect(events.at(-1)?.watchedSeconds).toBe(5);
  });

  it("resumes a partial period, records threshold stop, and keeps observing credits", () => {
    const { recorder, tick, video, events } = setup();
    recorder.start();
    tick(5);
    recorder.pause();
    const id = recorder.sessionId;
    recorder.start();
    expect(recorder.sessionId).toBe(id);
    video.currentTime = 79;
    recorder.discontinuity();
    tick(1, 0);
    tick(1);
    expect(events.at(-1)?.type).toBe("stop");
    tick(5);
    recorder.stop();
    recorder.stop();
    expect(events.at(-1)?.progress).toBe(85);
    expect(events.filter((e) => e.type === "stop")).toHaveLength(2);
  });

  it("creates a fresh period on replay and ignores playback that never started", () => {
    const { recorder, tick, video, events } = setup();
    recorder.stop();
    recorder.pause();
    recorder.tick();
    expect(events).toEqual([]);
    recorder.start();
    tick(5);
    recorder.stop();
    const first = recorder.sessionId;
    video.currentTime = 0;
    recorder.start();
    expect(recorder.sessionId).not.toBe(first);
    expect(events.at(-1)?.watchedSeconds).toBe(0);
  });
});

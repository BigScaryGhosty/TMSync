import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_DB_VERSION, openHistoryDatabase, readRequest } from "./db";
import {
  closeHistoryTab,
  enrichHistory,
  getWatchSession,
  historyMediaKey,
  recordHistory,
} from "./store";
import type { HistoryCheckpoint, WatchEvent } from "./types";

let name: string;
const sender = { tabId: 1, frameId: 0 };
function checkpoint(overrides: Partial<HistoryCheckpoint> = {}): HistoryCheckpoint {
  return {
    sessionId: "period-1",
    sequence: 1,
    media: { mediaType: "movie", title: "Movie", ids: { tmdb: 42 } },
    type: "start",
    occurredAt: 1000,
    progress: 0,
    positionSeconds: 0,
    durationSeconds: 100,
    watchedSeconds: 0,
    watchedThreshold: 0.8,
    sourceHost: "example.test",
    ...overrides,
  };
}
const save = (changes: Partial<HistoryCheckpoint> = {}) =>
  recordHistory(checkpoint(changes), sender, name);
const session = () => getWatchSession("period-1", name);
async function events(): Promise<WatchEvent[]> {
  const db = await openHistoryDatabase(name);
  try {
    return await readRequest(db.transaction("events").objectStore("events").getAll());
  } finally {
    db.close();
  }
}

describe("local history database", () => {
  beforeEach(() => {
    name = crypto.randomUUID();
  });

  it("initializes versioned stores and indexes and survives reopening", async () => {
    const db = await openHistoryDatabase(name);
    expect(db.version).toBe(HISTORY_DB_VERSION);
    expect(Array.from(db.objectStoreNames)).toEqual([
      "events",
      "owners",
      "sessions",
      "syncRecords",
    ]);
    expect(Array.from(db.transaction("sessions").objectStore("sessions").indexNames)).toContain(
      "mediaKey",
    );
    db.close();
    await save();
    expect(await session()).toMatchObject({
      id: "period-1",
      title: "Movie",
      completed: false,
      identifiers: { tmdb: 42 },
    });
    expect(await events()).toHaveLength(1);
  });

  it("persists start, progress, pause and resumes the same partial viewing period", async () => {
    await save();
    await save({ sequence: 2, type: "progress", occurredAt: 6000, progress: 5, watchedSeconds: 5 });
    await save({ sequence: 3, type: "pause", occurredAt: 7000, progress: 6, watchedSeconds: 6 });
    await save({ sequence: 4, type: "start", occurredAt: 60_000, progress: 6, watchedSeconds: 6 });
    expect(await session()).toMatchObject({
      startedAt: 1000,
      updatedAt: 60_000,
      watchedSeconds: 6,
      completed: false,
    });
    expect((await events()).map((e) => e.type)).toEqual(["start", "progress", "pause", "start"]);
  });

  it("records completed stops and preserves completion time through later checkpoints", async () => {
    await save();
    await save({ sequence: 2, type: "stop", occurredAt: 9000, progress: 80 });
    await save({ sequence: 3, type: "progress", occurredAt: 14000, progress: 85 });
    expect(await session()).toMatchObject({
      completed: true,
      finishedAt: 9000,
      highestProgress: 85,
    });
  });

  it("keeps a partial stop without falsely completing it", async () => {
    await save();
    await save({ sequence: 2, type: "stop", progress: 20, watchedSeconds: 10 });
    expect(await session()).toMatchObject({ completed: false, watchedSeconds: 10 });
    expect((await session())?.finishedAt).toBeUndefined();
    expect((await events())[1]?.type).toBe("stop");
  });

  it("reconciles tab close at the last checkpoint without inventing time", async () => {
    await save({ progress: 60 });
    await save({
      sequence: 2,
      type: "progress",
      progress: 10,
      occurredAt: 6000,
      watchedSeconds: 15,
    });
    await closeHistoryTab(1, name);
    await closeHistoryTab(1, name);
    expect(await session()).toMatchObject({
      watchedSeconds: 15,
      completed: false,
      lastEvent: "stop",
    });
    expect((await events()).find((e) => e.type === "stop")).toMatchObject({
      progress: 10,
      occurredAt: 6000,
    });
    expect(await events()).toHaveLength(3);
  });

  it("rejects malformed checkpoints before opening a database", async () => {
    await expect(save({ watchedSeconds: Number.NaN })).rejects.toThrow();
    await expect(save({ watchedThreshold: 2 })).rejects.toThrow();
    expect(await session()).toBeUndefined();
  });

  it("never lowers highest progress or cumulative watched time", async () => {
    await save({ progress: 60 });
    await save({ sequence: 2, type: "progress", progress: 60, watchedSeconds: 20 });
    await save({ sequence: 3, type: "progress", progress: 10, watchedSeconds: 10 });
    expect(await session()).toMatchObject({ highestProgress: 60, watchedSeconds: 20 });
  });

  it("atomically ignores duplicate and out of order messages", async () => {
    await Promise.all([save(), save(), save()]);
    await save({ sequence: 3, type: "pause", watchedSeconds: 3 });
    await save({ sequence: 2, type: "progress", watchedSeconds: 99 });
    expect(await events()).toHaveLength(2);
    expect((await session())?.watchedSeconds).toBe(3);
  });

  it("serializes competing frames even after a threshold stop", async () => {
    const results = await Promise.all([
      save(),
      recordHistory(checkpoint({ sessionId: "other" }), { tabId: 1, frameId: 2 }, name),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await save({ sequence: 2, type: "stop", progress: 90 });
    expect(
      await recordHistory(
        checkpoint({ sessionId: "other", occurredAt: 5000 }),
        { tabId: 1, frameId: 2 },
        name,
      ),
    ).toBe(false);
    expect(await getWatchSession("other", name)).toBeUndefined();
  });

  it("retains separate periods and rewatches under the same media key", async () => {
    await save({ type: "stop", progress: 90 });
    await save({ sessionId: "rewatch", occurredAt: 86_400_000 });
    const rewatch = await getWatchSession("rewatch", name);
    expect(rewatch?.mediaKey).toBe((await session())?.mediaKey);
    expect(rewatch?.completed).toBe(false);
    expect(await events()).toHaveLength(2);
  });

  it("does not import previously rejected viewing time when another frame takes over", async () => {
    await save();
    await save({ sequence: 2, type: "progress", occurredAt: 6000, watchedSeconds: 5 });
    const other = { tabId: 1, frameId: 2 };
    await recordHistory(
      checkpoint({ sessionId: "other", occurredAt: 6000, watchedSeconds: 5 }),
      other,
      name,
    );
    await recordHistory(
      checkpoint({
        sessionId: "other",
        sequence: 2,
        type: "progress",
        occurredAt: 40000,
        watchedSeconds: 39,
      }),
      other,
      name,
    );
    await recordHistory(
      checkpoint({
        sessionId: "other",
        sequence: 3,
        type: "progress",
        occurredAt: 45000,
        watchedSeconds: 44,
      }),
      other,
      name,
    );
    expect((await getWatchSession("other", name))?.watchedSeconds).toBe(5);
    expect((await session())?.watchedSeconds).toBe(5);
  });

  it("enriches available identities without changing the grouping key or losing them on progress", async () => {
    await save();
    await enrichHistory("period-1", { trakt: 8, imdb: "tt123" }, name);
    await save({ sequence: 2, type: "progress" });
    expect((await session())?.identifiers).toEqual({ tmdb: 42, trakt: 8, imdb: "tt123" });
  });

  it("uses strongest existing ids, episode coordinates, and scoped scraped fallbacks", () => {
    const media = checkpoint().media;
    expect(historyMediaKey(media, "a")).toBe(historyMediaKey({ ...media, title: "Changed" }, "b"));
    expect(historyMediaKey({ ...media, episode: 1 }, "a")).not.toBe(
      historyMediaKey({ ...media, episode: 2 }, "a"),
    );
    expect(historyMediaKey({ ...media, ids: undefined }, "a")).not.toBe(
      historyMediaKey({ ...media, ids: undefined }, "b"),
    );
  });
});

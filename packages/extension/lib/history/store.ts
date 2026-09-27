import { type ParsedMedia, primaryId } from "@tmsync/shared";
import { openHistoryDatabase, readRequest, transactionDone } from "./db";
import type { HistoryCheckpoint, HistoryIdentifiers, HistoryOwner, WatchSession } from "./types";
import { historyCheckpointSchema } from "./validation";

export function historyMediaKey(media: ParsedMedia, sourceHost: string): string {
  const id = primaryId(media);
  const identity = id
    ? [id.namespace, String(id.value)]
    : ["scraped", sourceHost, media.title.trim().toLowerCase(), media.year ?? null];
  return JSON.stringify([media.mediaType, identity, media.season ?? null, media.episode ?? null]);
}

/** One transaction serializes concurrent frames and commits the event + summary together. */
export async function recordHistory(
  checkpoint: HistoryCheckpoint,
  sender: { tabId: number; frameId: number },
  databaseName?: string,
): Promise<boolean> {
  historyCheckpointSchema.parse(checkpoint);
  const db = await openHistoryDatabase(databaseName);
  try {
    const tx = db.transaction(["sessions", "events", "owners"], "readwrite");
    const done = transactionDone(tx);
    const sessions = tx.objectStore("sessions");
    const owners = tx.objectStore("owners");
    const mediaKey = historyMediaKey(checkpoint.media, checkpoint.sourceHost);
    const key = JSON.stringify([sender.tabId, mediaKey]);
    let accepted = false;
    const ownerRequest = owners.get(key);
    ownerRequest.onsuccess = () => {
      const owner = ownerRequest.result as HistoryOwner | undefined;
      // Retain ownership after threshold stop: other frames must not count credits again.
      if (
        owner &&
        owner.sessionId !== checkpoint.sessionId &&
        owner.frameId !== sender.frameId &&
        checkpoint.occurredAt - owner.updatedAt < 30_000
      )
        return;
      const request = sessions.get(checkpoint.sessionId);
      request.onsuccess = () => {
        const previous = request.result as WatchSession | undefined;
        if (previous && checkpoint.sequence <= previous.sequence) return;
        const progress = Math.min(100, Math.max(0, checkpoint.progress));
        const completed =
          (previous?.completed ?? false) || progress >= checkpoint.watchedThreshold * 100;
        // A frame taking ownership must not import time it observed while another
        // frame owned the ledger. Only consecutive accepted observations add time.
        const delta =
          previous && owner?.sessionId === checkpoint.sessionId
            ? Math.max(0, checkpoint.watchedSeconds - previous.observedSeconds)
            : 0;
        const session: WatchSession = {
          mediaType: checkpoint.media.mediaType,
          title: checkpoint.media.title,
          year: checkpoint.media.year,
          season: checkpoint.media.season,
          episode: checkpoint.media.episode,
          id: checkpoint.sessionId,
          mediaKey: previous?.mediaKey ?? mediaKey,
          startedAt: previous?.startedAt ?? checkpoint.occurredAt,
          updatedAt: Math.max(previous?.updatedAt ?? 0, checkpoint.occurredAt),
          finishedAt: previous?.finishedAt ?? (completed ? checkpoint.occurredAt : undefined),
          durationSeconds: checkpoint.durationSeconds ?? previous?.durationSeconds,
          watchedSeconds: (previous?.watchedSeconds ?? 0) + delta,
          observedSeconds: Math.max(previous?.observedSeconds ?? 0, checkpoint.watchedSeconds),
          highestProgress: Math.max(previous?.highestProgress ?? 0, progress),
          completed,
          sourceHost: checkpoint.sourceHost,
          identifiers: { ...checkpoint.media.ids, ...previous?.identifiers },
          sequence: checkpoint.sequence,
          lastEvent: checkpoint.type,
          lastProgress: progress,
          positionSeconds: checkpoint.positionSeconds,
        };
        sessions.put(session);
        tx.objectStore("events").put({
          id: `${checkpoint.sessionId}:${checkpoint.sequence}`,
          sessionId: checkpoint.sessionId,
          type: checkpoint.type,
          occurredAt: checkpoint.occurredAt,
          progress,
          positionSeconds: checkpoint.positionSeconds,
          durationSeconds: checkpoint.durationSeconds,
          watchedSeconds: session.watchedSeconds,
        });
        owners.put({
          key,
          ...sender,
          sessionId: checkpoint.sessionId,
          updatedAt: checkpoint.occurredAt,
        });
        accepted = true;
      };
    };
    await done;
    return accepted;
  } finally {
    db.close();
  }
}

/** Enrich from existing resolution only; history never triggers a network request. */
export async function enrichHistory(
  sessionId: string,
  identifiers: HistoryIdentifiers,
  databaseName?: string,
): Promise<void> {
  const db = await openHistoryDatabase(databaseName);
  try {
    const tx = db.transaction("sessions", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("sessions");
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const session = request.result as WatchSession | undefined;
      if (session)
        store.put({ ...session, identifiers: { ...session.identifiers, ...identifiers } });
    };
    await done;
  } finally {
    db.close();
  }
}

export async function closeHistoryTab(tabId: number, databaseName?: string): Promise<void> {
  const db = await openHistoryDatabase(databaseName);
  try {
    const tx = db.transaction(["owners", "sessions", "events"], "readwrite");
    const done = transactionDone(tx);
    const owners = tx.objectStore("owners");
    const request = owners.index("tabId").openCursor(IDBKeyRange.only(tabId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const owner = cursor.value as HistoryOwner;
      const sessions = tx.objectStore("sessions");
      const sessionRequest = sessions.get(owner.sessionId);
      sessionRequest.onsuccess = () => {
        const session = sessionRequest.result as WatchSession | undefined;
        if (session && session.lastEvent !== "stop") {
          // The tab is gone: use the last observation, never invent unwitnessed time.
          tx.objectStore("events").put({
            id: `${session.id}:closed`,
            sessionId: session.id,
            type: "stop",
            occurredAt: session.updatedAt,
            progress: session.lastProgress,
            positionSeconds: session.positionSeconds,
            durationSeconds: session.durationSeconds,
            watchedSeconds: session.watchedSeconds,
          });
          sessions.put({ ...session, lastEvent: "stop" });
        }
      };
      cursor.delete();
      cursor.continue();
    };
    await done;
  } finally {
    db.close();
  }
}

export async function getWatchSession(
  id: string,
  databaseName?: string,
): Promise<WatchSession | undefined> {
  const db = await openHistoryDatabase(databaseName);
  try {
    return await readRequest(db.transaction("sessions").objectStore("sessions").get(id));
  } finally {
    db.close();
  }
}

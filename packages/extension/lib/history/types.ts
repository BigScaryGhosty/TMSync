import type { Tracker } from "@/lib/tracker/types";
import type { ParsedMedia } from "@tmsync/shared";

export type HistoryIdentifiers = Partial<
  Record<"tmdb" | "imdb" | "tvdb" | "trakt" | "anilist" | "mal" | "simkl", string | number>
>;

export interface WatchSession {
  id: string;
  mediaKey: string;
  mediaType: "movie" | "show";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  durationSeconds?: number;
  watchedSeconds: number;
  highestProgress: number;
  completed: boolean;
  sourceHost: string;
  sourceUrl?: string;
  identifiers: HistoryIdentifiers;
  /** Durable checkpoint state, never held exclusively by the service worker. */
  sequence: number;
  lastEvent: WatchEvent["type"];
  lastProgress: number;
  positionSeconds?: number;
  observedSeconds: number;
}

export interface WatchEvent {
  id: string;
  sessionId: string;
  type: "start" | "progress" | "pause" | "stop";
  occurredAt: number;
  progress: number;
  positionSeconds?: number;
  durationSeconds?: number;
  /** Session total at this event, allowing later day/week allocation without counting seeks. */
  watchedSeconds: number;
}

export interface SyncRecord {
  sessionId: string;
  tracker: Tracker;
  state: "pending" | "synced" | "failed";
  lastAttempt?: number;
  error?: string;
}

export interface HistoryCheckpoint {
  sessionId: string;
  sequence: number;
  media: ParsedMedia;
  type: WatchEvent["type"];
  occurredAt: number;
  progress: number;
  positionSeconds?: number;
  durationSeconds?: number;
  /** Cumulative observed playback wall time for this viewing period. */
  watchedSeconds: number;
  watchedThreshold: number;
  sourceHost: string;
}

export interface HistoryOwner {
  key: string;
  tabId: number;
  frameId: number;
  sessionId: string;
  updatedAt: number;
}

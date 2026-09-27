import { z } from "zod";

const nonnegative = z.number().finite().nonnegative();
export const historyCheckpointSchema = z.object({
  sessionId: z.string().min(1).max(100),
  sequence: nonnegative.int(),
  media: z.object({
    mediaType: z.enum(["movie", "show"]),
    title: z.string(),
    year: nonnegative.optional(),
    season: nonnegative.optional(),
    episode: nonnegative.optional(),
    ids: z.record(z.union([z.string(), z.number().finite()])).optional(),
  }),
  type: z.enum(["start", "progress", "pause", "stop"]),
  occurredAt: nonnegative,
  progress: nonnegative.max(100),
  positionSeconds: nonnegative.optional(),
  durationSeconds: nonnegative.optional(),
  watchedSeconds: nonnegative,
  watchedThreshold: nonnegative.max(1),
  sourceHost: z.string(),
});

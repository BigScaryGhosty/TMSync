import { HistoryRecorder } from "@/lib/history/recorder";
import { quickLinkSlugs } from "@/lib/storage";
import { routeTracker } from "@/lib/tracker";
import { type Tracker, isSeasonless, trackerLabel } from "@/lib/tracker/types";
import {
  type BadgeState,
  type BadgeStatus,
  type DerivedOutcome,
  type ScrobbleReply,
  type TrackerOutcome,
  onMessage,
  sendMessage,
} from "@/messaging";
import {
  type ParsedMedia,
  type Recipe,
  extract,
  isManualRecipe,
  primaryId,
  readField,
  recipeTrackers,
  selectRecipe,
} from "@tmsync/shared";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ScrobbleController } from "./controller";
import { PlaybackEvents } from "./playback";

const RECONCILE_DEBOUNCE_MS = 600;
/** Hard cap on how long a mutation burst may postpone a pending reconcile. */
const RECONCILE_MAX_WAIT_MS = 2000;
/** How often to check `location.href` for a client-side navigation. */
const LOCATION_POLL_MS = 400;
/** How long after a URL change late DOM still counts as "this page settling". */
const URL_SETTLE_MS = 4000;
const PROGRESS_PERSIST_MS = 5000;
const TAB_MEDIA_POLL_MS = 750;
const TAB_MEDIA_POLL_TRIES = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mediaKey(m: ParsedMedia): string {
  // Key by BOTH the id (when present) AND the title. Keying by id alone locked the
  // badge on SPAs that render the title late: the first extract fires before the
  // title exists, publishes with an empty title (the id stands in), and an id-only
  // key then dedupes away the re-publish once the real title loads — fatal for
  // AniList, which resolves by title (the page stayed stuck on "TMDB 197754").
  // Trakt id-only recipes carry no title, so their key is still stable (`…::…`).
  const p = primaryId(m);
  const id = p ? `${p.namespace}${p.value}` : "";
  return `${m.mediaType}:${id}:${m.title}:${m.season ?? ""}:${m.episode ?? ""}`;
}

/**
 * The episode suffix for the badge. Seasoned TV → ` S{n}E{m}`; anime (AniList,
 * episode but no season) → ` E{n}`; movies → "". So the badge always shows which
 * episode is scrobbling, including for season-less anime. `singleEpisode` (a resolved
 * AniList entry with exactly 1 episode — a movie, OVA, or special) drops the "E1":
 * the number is always 1, so it carries no information. (Not a movie-specific test.)
 * `seasonless` forces the ` E{n}` form even when a season was scraped — AniList is
 * seasonless (the cour IS the entry), so an AniList-tracked item on a seasoned site
 * shows ` E3`, not a misleading ` S1E3`.
 */
function episodeSuffix(m: ParsedMedia, singleEpisode = false, seasonless = false): string {
  if (!seasonless && m.season !== undefined) return ` S${m.season}E${m.episode ?? "?"}`;
  if (singleEpisode) return "";
  if (m.episode !== undefined) return ` E${m.episode}`;
  return "";
}

function label(m: ParsedMedia, seasonless = false): string {
  // A title-less, id-only recipe shows the id until the tracker resolves a real
  // title (which then replaces this in the badge).
  const idp = primaryId(m);
  const name = m.title || (idp ? `${idp.namespace.toUpperCase()} ${idp.value}` : "");
  const yr = m.year ? ` (${m.year})` : "";
  return `${name}${episodeSuffix(m, false, seasonless)}${yr}`;
}

/** Title as the tracker matched it, keeping the scraped episode (transparency).
 * `singleEpisode` renders a 1-episode entry (movie / OVA / special) without "E1".
 * `seasonless` drops the season (AniList entries are per-cour, not seasoned). */
function resolvedLabel(
  title: string,
  year: number | undefined,
  m: ParsedMedia,
  singleEpisode = false,
  seasonless = false,
): string {
  return `${title}${year ? ` (${year})` : ""}${episodeSuffix(m, singleEpisode, seasonless)}`;
}

/** Short per-tracker note from a failure reason (for the mark's tooltip + panel). */
function reasonNote(reason: string | undefined): string {
  switch (reason) {
    case "not_connected":
      return "connect";
    case "unresolved":
      return "not found";
    case "numbering_mismatch":
      return "numbering ✗";
    case "no_episode":
      return "no episode";
    case "needs_rewatch":
      return "rewatch?";
    default:
      return "failed";
  }
}

/** ok = recorded this phase; pending = enabled but nothing written yet (start/pause,
 * or AniList before its threshold); attention = failed / needs the user. */
function outcomeState(
  ok: boolean,
  action?: "start" | "pause" | "scrobble",
): TrackerOutcome["state"] {
  if (!ok) return "attention";
  return action === "scrobble" ? "ok" : "pending";
}

/** A tracker's note when it recorded: Trakt "added to history"; a cour tracker
 * (AniList, MAL) "saved" / "completed". Undefined while pending (nothing written yet). */
function okNote(
  tracker: Tracker,
  action: DerivedOutcome["action"],
  completed: boolean | undefined,
): string | undefined {
  if (action !== "scrobble") return undefined;
  if (isSeasonless(tracker)) return completed ? "completed" : "saved";
  return "added to history";
}

/** Every per-tracker outcome for this scrobble: the native tracker (top-level reply
 * fields) + each derived tracker. Silent crosswalk misses (skipped) are omitted —
 * the item just isn't mapped there. This structure scales to any number of trackers;
 * the badge renders it as tinted logos rather than an ever-growing prose string. */
function trackerOutcomes(reply: ScrobbleReply, tracker: Tracker): TrackerOutcome[] {
  const primary = reply.primaryTracker ?? tracker;
  const out: TrackerOutcome[] = [
    {
      tracker: primary,
      state: outcomeState(reply.ok, reply.action),
      note: !reply.ok
        ? reasonNote(reply.reason)
        : reply.info === "already_watched"
          ? "already watched"
          : okNote(primary, reply.action, reply.completed),
      detail: reply.ok ? undefined : reply.httpError,
    },
  ];
  for (const d of reply.derived ?? []) {
    if (d.skipped) continue;
    out.push({
      tracker: d.tracker,
      state: outcomeState(d.ok, d.action),
      note: !d.ok
        ? reasonNote(d.reason)
        : d.deferred
          ? "recording"
          : d.info === "already_watched"
            ? "already watched"
            : okNote(d.tracker, d.action, d.completed),
      detail: d.ok ? undefined : d.httpError,
    });
  }
  return out;
}

/** A stop reply with its deferred trackers' real outcomes (`scrobbleFollowUp`)
 * swapped in. Pure. */
export function mergeFollowUp(reply: ScrobbleReply, outcomes: DerivedOutcome[]): ScrobbleReply {
  const byTracker = new Map(outcomes.map((o) => [o.tracker, o]));
  return {
    ...reply,
    derived: reply.derived?.map((d) => (d.deferred ? (byTracker.get(d.tracker) ?? d) : d)),
  };
}

/** The neutral bar verb for a multi-track status — the per-tracker specifics live in
 * the tinted marks, so the text stays tracker-agnostic and constant in length. */
function neutralDetail(state: BadgeState, outcomes: TrackerOutcome[]): string | undefined {
  const attention = outcomes.some((o) => o.state === "attention");
  if (state === "scrobbled") return attention ? "recorded · needs attention" : "recorded";
  if (state === "error") return "needs attention";
  return undefined; // watching / paused / stopped / idle → use the state label
}

/** Build the badge status. Single-tracker keeps its specific text detail; a
 * multi-track recipe attaches structured `trackers[]` (tinted logos) and collapses
 * the detail to a neutral verb, so adding more trackers never bloats the bar text. */
export function statusFromReply(
  action: "start" | "pause" | "stop",
  reply: ScrobbleReply,
  m: ParsedMedia,
  tracker: Tracker,
): BadgeStatus {
  // Every tracker that asked to confirm a rewatch (native or derived), so the one
  // prompt confirms them all. A derived-only rewatch raises the prompt too.
  const rewatchTrackers = [
    ...(reply.reason === "needs_rewatch" ? [reply.primaryTracker ?? tracker] : []),
    ...(reply.derived ?? []).filter((d) => d.reason === "needs_rewatch").map((d) => d.tracker),
  ];
  const withRewatch = (st: BadgeStatus): BadgeStatus =>
    rewatchTrackers.length ? { ...st, rewatch: true, rewatchTrackers } : st;

  const outcomes = trackerOutcomes(reply, tracker);
  const primary = primaryStatus(action, reply, m, tracker);
  if (outcomes.length <= 1) return withRewatch(primary); // single tracker: specific detail

  // "Already watched" (or a rewatch awaiting confirmation) is the WHOLE item's
  // state only when no tracker will record it. If another tracker still records
  // (MAL behind AniList, or Trakt), show the normal watching/paused/recorded state
  // and let each tracker's mark carry its own note.
  const derived = (reply.derived ?? []).filter((d) => !d.skipped);
  const blocked = (info?: string, reason?: string) =>
    info === "already_watched" || reason === "needs_rewatch";
  const primaryBlocked = blocked(reply.info, reply.reason);
  if (primaryBlocked && derived.every((d) => blocked(d.info, d.reason))) {
    return withRewatch({ ...primary, detail: "already watched", trackers: outcomes });
  }
  const base = primaryBlocked
    ? primaryStatus(
        action,
        {
          ...reply,
          ok: true,
          reason: undefined,
          info: undefined,
          action: derived.some((d) => d.action === "scrobble") ? "scrobble" : reply.action,
        },
        m,
        tracker,
      )
    : primary;
  return withRewatch({ ...base, detail: neutralDetail(base.state, outcomes), trackers: outcomes });
}

function primaryStatus(
  action: "start" | "pause" | "stop",
  reply: ScrobbleReply,
  m: ParsedMedia,
  tracker: Tracker,
): BadgeStatus {
  const name = trackerLabel(tracker);
  // A seasonless tracker (AniList) has no seasons — the cour IS the entry — so drop
  // any scraped season: the label reads `E3`, not a misleading `S1E3`.
  const seasonless = isSeasonless(tracker);
  // Prefer what the tracker actually matched (transparency); keep the scraped S/E.
  const title = reply.resolvedTitle
    ? resolvedLabel(
        reply.resolvedTitle,
        reply.resolvedYear,
        m,
        reply.resolvedEpisodes === 1,
        seasonless,
      )
    : label(m, seasonless);
  if (reply.ok) {
    // Already at/above this episode on the tracker — nothing will be written (progress
    // never goes backwards). Say so UP FRONT (any phase), not a bare confusing "stopped".
    if (reply.info === "already_watched") {
      return {
        state: "stopped",
        title,
        detail: `already watched · ${name} at ep ${reply.atEpisode ?? "?"}`,
      };
    }
    if (action === "start") return { state: "watching", title };
    if (action === "pause") return { state: "paused", title };
    if (reply.action !== "scrobble") return { state: "stopped", title };
    if (seasonless) {
      // A cour tracker writes the list entry. The title already carries the episode
      // (E{n}); keep the detail short.
      return {
        state: "scrobbled",
        title,
        detail: reply.completed ? `completed on ${name}` : `saved to ${name}`,
        completed: reply.completed,
      };
    }
    return { state: "scrobbled", title, detail: "added to history" };
  }
  // A completed cour, re-watched: not an error. Prompt to confirm the rewatch.
  // Nothing was written; the badge offers "Rewatching?".
  // The main badge keeps saying "already watched"; the "Rewatching?" card above it
  // (from `rewatch`, added by statusFromReply) asks to confirm.
  if (reply.reason === "needs_rewatch") {
    return { state: "stopped", title, detail: `already watched · completed on ${name}` };
  }
  const detail =
    reply.reason === "not_connected"
      ? `connect ${name}`
      : reply.reason === "unresolved"
        ? `not found on ${name}`
        : reply.reason === "no_episode"
          ? "missing episode #"
          : reply.reason === "numbering_mismatch"
            ? // The cour guardrail: site numbering ≠ the tracker's entry (step 6).
              (reply.httpError ?? `site numbering doesn't match ${name}`)
            : `scrobble failed${reply.status ? ` (${reply.status})` : ""}${
                reply.httpError ? `: ${reply.httpError.slice(0, 80)}` : ""
              }`;
  return { state: "error", title, detail };
}

/**
 * Emit a window event once per frame whenever the URL changes client-side.
 *
 * This POLLS `location.href` (plus `popstate` for an instant back/forward). It
 * used to patch `history.pushState`/`replaceState` instead, which never worked:
 * a content script runs in an isolated world with its OWN `history` wrapper, so
 * the patch only ever saw calls we made ourselves, never the page's. (The
 * Navigation API's `navigate` event doesn't fire in the isolated world either,
 * which is why `wxt:locationchange` is no use here.) `location` is the one thing
 * that always reflects the real URL from any world, so poll it, mirroring
 * anilist.content.tsx / trakt.content.tsx.
 *
 * Without this, an SPA episode swap (anikototv `/ep-10` to `/ep-11`) only got
 * re-extracted if the site happened to also mutate <head> (the title observer) or
 * reload the top frame's <video>. On a site that changes neither, the badge kept
 * scrobbling the previous episode.
 */
let locationWatched = false;
function ensureLocationChangeEvents(ctx: ContentScriptContext): void {
  if (locationWatched) return;
  locationWatched = true;
  let lastHref = location.href;
  const fire = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    window.dispatchEvent(new Event("tmsync:locationchange"));
  };
  ctx.addEventListener(window, "popstate", fire); // dropped on invalidation
  ctx.setInterval(fire, LOCATION_POLL_MS);
}

/**
 * Per-frame watch-session manager. Handles the three roles a frame can play:
 *  - matcher: this frame matches a recipe → extract + publish media for the tab
 *    (so a cross-origin player iframe can consume it) and seed the badge.
 *  - player: this frame owns the <video> → resolve media (its own or pulled from
 *    the tab) and drive the scrobble state machine.
 *  - both (no iframe): the common case.
 * Re-reconciles on SPA navigation and on the video loading new media.
 */
type PlayerFrame = "auto" | "top" | "iframe";

export class SessionManager {
  private localMedia: ParsedMedia | null = null;
  private videoSelector = "video";
  private frame: PlayerFrame = "auto";
  private watchedThreshold = 0.8;
  /** The PRIMARY/native tracker (its numbering is what the page speaks). */
  private tracker: Tracker = "trakt";
  /** MULTI-TRACK: the full toggled set. Derived tracker(s) are written via the
   * anime-map crosswalk in the background. Kept in sync with `tracker`. */
  private trackers: Tracker[] = ["trakt"];
  private lastPublishedKey: string | null = null;
  /** A publication is tracker-ready only after its original badge/preflight flow finishes. */
  private readyPublishedKey: string | null = null;
  private publicationVersion = 0;
  /** Top frame: a matched recipe is currently showing a badge for this tab. Lets
   * us (a) clear the badge + stop the session when an SPA navigates AWAY to a
   * non-scrobblable page, and (b) drop a scrobble's late UI reply once we've left
   * (so it can't re-show "watching" after the badge was cleared). */
  private badgeActive = false;
  /** Manual recipe matched but no selection yet — wait for the user's pick. */
  private manualAwaiting = false;
  /** Show page matched but its URL carries no episode — wait for the user to
   * supply season/episode via the badge (e.g. a "?play=true" deep link). */
  private episodeAwaiting = false;
  /** URL an episode override was last applied for. Cleared (and the override
   * dropped) when we navigate away, so returning to an S/E-less URL re-prompts. */
  private episodeOverrideUrl: string | null = null;
  private framesObserver: MutationObserver | null = null;
  private readonly seenFrameOrigins = new Set<string>();
  private currentKey: string | null = null;
  /** The last stop's reply, kept so a `scrobbleFollowUp` can update its status. */
  private lastStop: { reply: ScrobbleReply; media: ParsedMedia; tracker: Tracker } | null = null;
  /** A follow-up that arrived before its stop's reply. */
  private earlyFollowUp: { media: ParsedMedia; outcomes: DerivedOutcome[] } | null = null;
  /** The last phase this frame sent. A start or pause after a stop means playback
   * went on (the same episode replayed), so a late follow-up must not replace it. */
  private lastAction: "start" | "pause" | "stop" | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private controller: ScrobbleController | null = null;
  private history: HistoryRecorder | null = null;
  private historyVideo: HTMLVideoElement | null = null;
  private historyKey: string | null = null;
  private historyAbort: AbortController | null = null;
  private readonly playback = new PlaybackEvents(() => this.scheduleReconcile());
  private abort: AbortController | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest time the currently pending reconcile may be postponed to. */
  private reconcileDeadline = 0;
  private videoObserver: MutationObserver | null = null;
  private videoObserverTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForScrobbleVideo = false;
  /** Bounded count of synthetic player-nudges this session (reveal hover-gated bars). */
  private metadataNudges = 0;
  /** Until when the page counts as "settling" after a client-side navigation. The
   * URL flips FIRST and the new episode's DOM lands a moment later, so a single
   * post-nav extract can still read the outgoing episode. While this is live, body
   * mutations re-extract (debounced) even though nothing is `awaitingMetadata`. */
  private urlSettleUntil = 0;
  /** True while the extract is still missing something the recipe expects (a title
   * or an episode). Some players only render those into their chrome (top/bottom
   * bar) on hover/play, so an early extract falls back to a movie-by-URL-id. While
   * this is set, late DOM changes trigger a re-extract; it costs nothing once we
   * have what we need. */
  private awaitingMetadata = true;

  constructor(
    private readonly ctx: ContentScriptContext,
    private recipes: Recipe[],
  ) {}

  private get isTop(): boolean {
    return window === window.top;
  }

  start(): void {
    ensureLocationChangeEvents(this.ctx);
    window.addEventListener("tmsync:locationchange", this.onLocationChange, {
      signal: this.frameSignal(),
    });
    this.ctx.onInvalidated(() => this.teardownSession());

    // SPA sites often set the real title/og:title AFTER initial load (e.g. cineby
    // shows the site name first). Re-extract when <head> metadata changes.
    if (document.head) {
      const headObserver = new MutationObserver(this.scheduleReconcile);
      headObserver.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["content"],
      });
      this.ctx.onInvalidated(() => headObserver.disconnect());
    }

    // Some players only render the title/season/episode into their overlay chrome
    // when it's revealed (hover/play), so the first extract misses them and can
    // fall back to a movie by the URL's tmdb id. Watch the body for those late
    // nodes and re-extract — gated on `awaitingMetadata`, so it does nothing once
    // we've got what the recipe asked for. (Shadow-DOM badge mutations aren't
    // observed, so this can't loop on our own UI.)
    if (document.body) {
      const metaObserver = new MutationObserver(() => {
        if (this.awaitingMetadata || Date.now() < this.urlSettleUntil) this.scheduleReconcile();
      });
      metaObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      this.ctx.onInvalidated(() => metaObserver.disconnect());
    }

    // A stop's deferred trackers (Simkl waiting out its lock) finished: show their
    // outcome on the stop's status. It can beat the stop's own reply here, so keep
    // it until that reply lands.
    const offFollowUp = onMessage("scrobbleFollowUp", ({ data }) => {
      const last = this.lastStop;
      if (!last || mediaKey(last.media) !== mediaKey(data.media)) {
        this.earlyFollowUp = data;
        return;
      }
      this.lastStop = { ...last, reply: mergeFollowUp(last.reply, data.outcomes) };
      // The next episode already plays, or this one plays again: its status must
      // not be overwritten.
      if (this.currentKey !== null && this.currentKey !== mediaKey(data.media)) return;
      if (this.lastAction !== "stop") return;
      this.reportStop(this.lastStop);
    });
    this.ctx.onInvalidated(() => offFollowUp());

    // A correction was saved → drop the current (wrong) session and re-resolve.
    const offRecheck = onMessage("recheck", () => {
      this.lastPublishedKey = null;
      this.teardownSession();
      void this.reconcile();
    });
    this.ctx.onInvalidated(() => offRecheck());

    // Any video starting to play is a strong signal to (re-)evaluate — catches a
    // player that reuses the trailer's element or appears only after Play.
    window.addEventListener(
      "play",
      () => {
        this.ensureHistory();
        void this.ensurePlaying();
      },
      {
        capture: true,
        signal: this.frameSignal(),
      },
    );

    void this.reconcile();
    // Run in EVERY frame, not just the top: aggregator embeds nest iframes (rive →
    // vsrc.su → the real video host), and a frame can only see its OWN children.
    // Each frame reporting its child origins is what surfaces a deeply-nested
    // player in the popup so the user can enable it. (The badge hint stays top-only.)
    this.watchPlayerFrames();
  }

  /** AbortSignal tied to the content-script lifetime (frame-level listeners). */
  private frameSignal(): AbortSignal {
    const ac = new AbortController();
    this.ctx.onInvalidated(() => ac.abort());
    return ac.signal;
  }

  /** A client-side navigation (SPA episode swap, back/forward). Re-extract now, and
   * keep re-extracting on DOM changes for a moment: the new episode's markup often
   * lands after the URL does. */
  private onLocationChange = (): void => {
    this.urlSettleUntil = Date.now() + URL_SETTLE_MS;
    this.scheduleReconcile();
  };

  private scheduleReconcile = (): void => {
    const now = Date.now();
    if (this.reconcileTimer) {
      // Re-arming on every call starves the extract on a page that never goes
      // quiet (a player repainting its progress bar, an ad carousel): each
      // mutation pushes the timer out another RECONCILE_DEBOUNCE_MS. Past the
      // cap, let the pending timer fire instead of postponing it again.
      if (now >= this.reconcileDeadline) return;
      clearTimeout(this.reconcileTimer);
    } else {
      this.reconcileDeadline = now + RECONCILE_MAX_WAIT_MS;
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile();
    }, RECONCILE_DEBOUNCE_MS);
  };

  private async reconcile(): Promise<void> {
    await this.matchAndPublish();
    // Still missing the title/episode? Poke the player to reveal a hover-gated
    // control bar (bounded); the nudge schedules another reconcile.
    if (this.awaitingMetadata) this.maybeNudgeForMetadata();
    // Awaiting the user: a manual-site title pick, or the episode # for an
    // S/E-less show URL. Nothing to play until they choose.
    if (this.manualAwaiting || this.episodeAwaiting) return;
    await this.ensurePlaying();
  }

  /** If this frame matches a recipe, extract + publish the media and seed the badge. */
  private async matchAndPublish(): Promise<void> {
    const engineCtx = { document, url: location.href };

    // Navigated away from the URL an episode override was set for: drop it so a
    // later return to that (ambiguous) URL re-prompts instead of reusing a stale
    // episode it may no longer be playing.
    if (this.episodeOverrideUrl && this.episodeOverrideUrl !== location.href) {
      void sendMessage("clearEpisodeOverride", { url: this.episodeOverrideUrl });
      this.episodeOverrideUrl = null;
    }

    const recipe = selectRecipe(this.recipes, engineCtx);
    if (!recipe) {
      this.localMedia = null;
      this.awaitingMetadata = true;
      this.manualAwaiting = false;
      this.episodeAwaiting = false;
      if (this.isTop) {
        await sendMessage("publishManualContext", null);
        // SPA navigated away from a scrobblable page to one no recipe covers
        // (e.g. flickystream player → its show detail page, no <video>). Nothing
        // on a detached video fires play/pause/ended, so without this the badge
        // would stay "scrobbling" forever. Commit the stop, drop the tab session
        // (also stops a player iframe via recheck), and clear the badge — once.
        if (this.badgeActive) {
          this.badgeActive = false;
          this.lastPublishedKey = null;
          this.teardownSession();
          await sendMessage("stopTabSession", undefined);
          await sendMessage("reportScrobble", { state: "stopped", hide: true });
        }
      }
      return;
    }
    // A recipe covers this page → the top frame owns a badge for it now.
    if (this.isTop) this.badgeActive = true;

    // Manual recipe: nothing to scrape. The top frame derives the page key,
    // looks up a remembered pick, and otherwise prompts the user via the badge.
    if (isManualRecipe(recipe)) {
      this.episodeAwaiting = false;
      if (this.isTop) await this.handleManual(recipe, engineCtx);
      else this.localMedia = null; // a player iframe consumes the published media
      return;
    }

    this.manualAwaiting = false;
    const result = extract(recipe, engineCtx);
    if (!result.ok) {
      this.localMedia = null;
      return;
    }
    let media = result.media;

    // A show whose URL carries no episode (e.g. a Cineby "?play=true" deep link):
    // the page can't tell us which episode is playing. Apply a season/episode the
    // user supplied for this URL, else prompt for it via the badge — without one
    // the scrobble would fail with "missing episode #".
    if (media.mediaType === "show" && media.episode === undefined) {
      const override = await sendMessage("getEpisodeOverride", undefined);
      if (override) {
        media = { ...media, season: override.season, episode: override.episode };
        this.episodeOverrideUrl = location.href;
      } else {
        // Enter the prompt. Only the first time (not on the recheck-driven
        // re-reconcile below) do we stop the tab session — otherwise the still-
        // playing player iframe keeps reporting the previous episode and the
        // prompt never sticks. The guard also prevents a recheck → reconcile loop.
        if (!this.episodeAwaiting) {
          this.episodeAwaiting = true;
          await sendMessage("stopTabSession", undefined);
        }
        this.awaitingMetadata = true;
        this.localMedia = null;
        this.lastPublishedKey = null;
        this.teardownSession();
        await sendMessage("reportScrobble", {
          state: "idle",
          title: label(media),
          detail: "set the episode to scrobble",
          needEpisode: true,
        });
        return;
      }
    }

    this.episodeAwaiting = false;
    this.localMedia = media;
    // Still missing something this recipe scrapes (a title or an episode)? Keep
    // watching the DOM — a hover-gated player bar (e.g. aether.bar's `S1 - E5`)
    // may render it a moment later, and the body observer will re-extract.
    this.awaitingMetadata =
      (recipe.extract?.title !== undefined && !media.title) ||
      ((recipe.extract?.episode !== undefined || recipe.extract?.season !== undefined) &&
        media.episode === undefined);
    this.videoSelector = recipe.video.selector;
    this.frame = recipe.video.frame;
    this.watchedThreshold = recipe.video.watchedThreshold;
    // Route by TYPE: a movie on an anilist (anime) site still goes to Trakt.
    this.tracker = routeTracker(recipe.tracker, media.mediaType);
    // MULTI-TRACK: the full toggled set — the background derives the non-native
    // one(s) via the crosswalk. Single-tracker recipes yield [tracker] (unchanged).
    this.trackers = recipeTrackers(recipe);

    // A cour tracker resolves by TITLE here: a scraped tmdbId can't stand in for it. On
    // an SPA the URL's tmdbId is present immediately but the title (`.title span`)
    // renders later, so an early extract yields an empty title + a tmdbId. Without
    // this guard we'd publish a useless "TMDB <id>" entry that it can't resolve
    // (and the dedup key would lock the badge there). Wait for the title instead —
    // a later reconcile (head/title mutation) re-runs this with the real title.
    if (isSeasonless(this.tracker) && !media.title) {
      this.localMedia = null;
      return;
    }

    this.ensureHistory(media);

    // Avoid churn from the head observer firing on unrelated mutations. The key
    // includes the tracker set so re-toggling trackers on the SAME media (a recipe
    // edit) still re-publishes — otherwise the "now playing" panel keeps the stale
    // tracker list while the badge marks (from the live reply) show the new one.
    const key = `${mediaKey(media)}|${this.tracker}|${this.trackers.join(",")}`;
    if (key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;
    this.readyPublishedKey = null;
    const publication = ++this.publicationVersion;

    await sendMessage("publishMedia", {
      media,
      tracker: this.tracker,
      trackers: this.trackers,
      videoSelector: recipe.video.selector,
      frame: recipe.video.frame,
      watchedThreshold: recipe.video.watchedThreshold,
    });

    // Seed the badge immediately with the scraped title, then refine it with what
    // the tracker actually matched — so the user can verify (and fix) the target
    // BEFORE pressing play, not only after the first scrobble fires.
    const trackerName = trackerLabel(this.tracker);
    const seasonless = isSeasonless(this.tracker); // per-cour trackers have no seasons
    await sendMessage("reportScrobble", { state: "idle", title: label(media, seasonless) });
    const resolved = await sendMessage("resolveMedia", { media, tracker: this.tracker });
    if (publication !== this.publicationVersion) return;
    if (!(resolved.resolved && resolved.title)) {
      await sendMessage("reportScrobble", {
        state: "error",
        title: label(media, seasonless),
        detail:
          resolved.reason === "not_connected"
            ? `connect ${trackerName}`
            : `not found on ${trackerName} · click to fix`,
      });
    } else {
      // A cour tracker never lowers progress. Say UP FRONT what playing will do:
      // "already watched" only when EVERY enabled tracker already counts this
      // episode (else another tracker still records it), and raise "Rewatching?"
      // for any completed entry before play, not only once playback starts.
      const standing =
        media.episode !== undefined && this.trackers.some(isSeasonless)
          ? await sendMessage("getWatchStanding", {})
          : [];
      if (publication !== this.publicationVersion) return;
      const rewatchTrackers = standing.filter((w) => w.completed).map((w) => w.tracker);
      const allAlready =
        standing.length === this.trackers.length && standing.every((w) => w.already);
      const only = standing.length === 1 ? standing[0] : undefined;
      const detail = !allAlready
        ? "press play to scrobble"
        : only
          ? only.completed
            ? `already watched · completed on ${trackerLabel(only.tracker)}`
            : `already watched · ${trackerLabel(only.tracker)} at ep ${only.atEpisode}`
          : "already watched";
      await sendMessage("reportScrobble", {
        state: "idle",
        title: resolvedLabel(resolved.title, resolved.year, media, false, seasonless),
        detail,
        ...(rewatchTrackers.length ? { rewatch: true, rewatchTrackers } : {}),
      });
    }

    // Anime crosswalk: when this anime site declares how to read its stable series
    // slug (`canonical`), remember `(host, AniList id) → slug` so AniList quick
    // links can later deep-link the EXACT page instead of a guessed title-slug.
    if (
      this.tracker === "anilist" &&
      recipe.canonical &&
      resolved.resolved &&
      resolved.id !== undefined
    ) {
      const slug = readField(recipe.canonical, { document, url: location.href });
      if (slug) {
        const host = new URL(location.href).hostname;
        const k = `${host}:${resolved.id}`;
        const map = await quickLinkSlugs.getValue();
        if (map[k] !== slug) {
          map[k] = slug;
          await quickLinkSlugs.setValue(map);
        }
      }
    }

    // A recipe just resolved but the top frame has no <video> — re-check for an
    // un-enabled player frame now (not only on the next DOM mutation), so a static
    // watch page still gets the "enable the player frame" hint.
    if (this.isTop && !this.findVideo()) void this.scanPlayerFrames();
    if (publication === this.publicationVersion) this.readyPublishedKey = key;
  }

  /**
   * Manual recipe (top frame). There's nothing to scrape, so derive a stable
   * page key (the recipe's manualKey value, else the page title), publish the
   * manual context for the badge, and look up a remembered pick. If one exists,
   * drive it exactly like a scraped match; otherwise prompt the user to pick.
   */
  private async handleManual(
    recipe: Recipe,
    engineCtx: { document: Document; url: string },
  ): Promise<void> {
    this.videoSelector = recipe.video.selector;
    this.frame = recipe.video.frame;
    this.watchedThreshold = recipe.video.watchedThreshold;
    this.tracker = recipe.tracker;
    this.trackers = recipeTrackers(recipe);

    const pageKey =
      (recipe.manualKey ? readField(recipe.manualKey, engineCtx) : null) ?? document.title.trim();
    await sendMessage("publishManualContext", { recipeId: recipe.id, pageKey });

    const media = await sendMessage("getManualMedia", { recipeId: recipe.id, pageKey });
    if (!media) {
      // No selection for what's playing — stop any stale session and prompt.
      this.manualAwaiting = true;
      this.localMedia = null;
      this.lastPublishedKey = null;
      this.teardownSession();
      await sendMessage("reportScrobble", {
        state: "idle",
        detail: "Pick what you’re watching",
        pick: true,
      });
      return;
    }

    this.manualAwaiting = false;
    this.localMedia = media;
    // A manually-picked movie still routes to Trakt (constraint #1).
    this.tracker = routeTracker(recipe.tracker, media.mediaType);
    this.ensureHistory(media);
    const key = `manual:${pageKey}:${mediaKey(media)}`;
    if (key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;
    this.readyPublishedKey = null;
    const publication = ++this.publicationVersion;

    await sendMessage("publishMedia", {
      media,
      tracker: this.tracker,
      trackers: this.trackers,
      videoSelector: this.videoSelector,
      frame: this.frame,
      watchedThreshold: this.watchedThreshold,
    });
    // The pick is locked to a Trakt entry via a correction, so resolveMedia hits;
    // either way the title is set, so seed the badge and let play scrobble it.
    const resolved = await sendMessage("resolveMedia", { media, tracker: this.tracker });
    if (publication !== this.publicationVersion) return;
    const seasonless = isSeasonless(this.tracker);
    await sendMessage("reportScrobble", {
      state: "idle",
      title:
        resolved.resolved && resolved.title
          ? resolvedLabel(resolved.title, resolved.year, media, false, seasonless)
          : label(media, seasonless),
      detail: "press play to scrobble",
    });
    if (publication === this.publicationVersion) this.readyPublishedKey = key;
  }

  /**
   * The first <video> that isn't a muted, looping background trailer (common on
   * movie landing pages). Falls back to any video if all look like trailers.
   */
  private findVideo(): HTMLVideoElement | null {
    const seen = new Set<HTMLVideoElement>();
    const candidates: HTMLVideoElement[] = [];
    for (const sel of [this.videoSelector, "video"]) {
      for (const v of document.querySelectorAll<HTMLVideoElement>(sel)) {
        if (!seen.has(v)) {
          seen.add(v);
          candidates.push(v);
        }
      }
    }
    // Exclude muted, looping background trailers entirely (never fall back to
    // one — that would scrobble just from viewing a movie landing page). Prefer
    // a video that's actually playing.
    const real = candidates.filter((v) => !(v.loop && v.muted));
    return real.find((v) => !v.paused) ?? real[0] ?? null;
  }

  private async pullTabMedia(): Promise<{ media: ParsedMedia; frame: PlayerFrame } | null> {
    for (let i = 0; i < TAB_MEDIA_POLL_TRIES; i++) {
      const tab = await sendMessage("getTabMedia", undefined);
      if (tab) {
        this.videoSelector = tab.videoSelector;
        this.watchedThreshold = tab.watchedThreshold;
        // Cross-frame: the player iframe must record to the SAME tracker(s) the
        // matcher frame routed to — otherwise an iframe anime recipe scrobbles to
        // Trakt (no season → "missing episode #") instead of AniList.
        this.tracker = tab.tracker;
        this.trackers = tab.trackers ?? [tab.tracker];
        return { media: tab.media, frame: tab.frame };
      }
      await sleep(TAB_MEDIA_POLL_MS);
    }
    return null;
  }

  /**
   * Find the video and start a session for the resolved media (its own or the
   * tab's). The play decision is trailer-skip (findVideo) + one-owner-per-tab
   * dedup in the background — a wrong "iframe"/"top" guess no longer blocks it.
   */
  private async ensurePlaying(): Promise<void> {
    // Reconcile, play and video-discovery can race a pending preflight. None of
    // them may turn an early local observer into an early tracker controller.
    if (
      this.localMedia &&
      (!this.lastPublishedKey || this.lastPublishedKey !== this.readyPublishedKey)
    )
      return;
    let media = this.localMedia;
    if (!media) {
      const tab = await this.pullTabMedia();
      if (!tab) return;
      media = tab.media;
    }

    const video = this.findVideo();
    if (!video) {
      this.observeForVideo();
      return;
    }

    const key = mediaKey(media);
    if (this.controller && key === this.currentKey && this.currentVideo === video) return;

    this.startSession(video, media);
  }

  /**
   * Watch for cross-origin player iframes (runs in EVERY frame). Two jobs:
   *  - Always accumulate every cross-origin iframe origin THIS frame can see
   *    (debounced, only when new) so the popup can offer player frames to enable —
   *    including ones nested inside an already-enabled aggregator frame, which the
   *    top frame can't see across the origin boundary.
   *  - Top frame only: when the recipe says the player is in an iframe and none is
   *    enabled yet, push an actionable badge hint (main feedback channel, no console).
   */
  private watchPlayerFrames(): void {
    void this.scanPlayerFrames();
    // Debounce: the subtree observer fires constantly on busy SPAs; we only need
    // to re-scan iframes occasionally.
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.framesObserver = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void this.scanPlayerFrames();
      }, 500);
    });
    this.framesObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.ctx.onInvalidated(() => this.framesObserver?.disconnect());
  }

  /**
   * Accumulate the cross-origin iframe origins this frame sees (for the popup's
   * enable list), and — top frame only — surface the "enable the player frame" badge
   * hint. Re-run on iframe mutations AND right after a recipe resolves, so a static
   * page (no further mutations) still gets the hint.
   */
  private async scanPlayerFrames(): Promise<void> {
    const origins = this.crossOriginIframeOrigins();
    if (origins.length === 0) return;

    const fresh = origins.filter((o) => !this.seenFrameOrigins.has(o));
    if (fresh.length > 0) {
      for (const o of fresh) this.seenFrameOrigins.add(o);
      void sendMessage("reportFrameOrigins", origins);
    }

    // The player is in a frame we can't see a <video> in. Fire when the recipe says
    // the player is an iframe, OR it's "auto" and there's no <video> in the top
    // document once a recipe has matched — the common real case: an imported recipe
    // whose embed host isn't enabled, or a valid recipe whose embed the site owner
    // has since swapped. Without a content script in that frame nothing tracks
    // playback, so say so instead of resting on a "press play" badge that never
    // advances.
    if (!this.isTop) return;
    const playerInFrame =
      this.frame === "iframe" || (this.frame === "auto" && !!this.localMedia && !this.findVideo());
    if (!playerInFrame) return;
    // The broad "enable all sites" grant runs the content script in EVERY frame, so
    // the player is already covered — never nag then.
    if (await sendMessage("hasAllSitesGrant", undefined)) return;
    const enabled = new Set(await sendMessage("listEnabledSites", undefined));
    // A cross-origin frame is already enabled → the player is set up; the rest are
    // almost certainly ads. Stay quiet.
    if (origins.some((o) => enabled.has(o))) return;
    await sendMessage("reportScrobble", {
      state: "error",
      title: this.localMedia ? label(this.localMedia) : undefined,
      detail: "can’t see the video. Allow the player frame in the TMSync popup",
      needFrame: true,
    });
  }

  private crossOriginIframeOrigins(): string[] {
    const set = new Set<string>();
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const u = new URL((frame as HTMLIFrameElement).src, location.href);
        if ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin) {
          set.add(u.origin);
        }
      } catch {
        // empty/relative/unparseable src — skip
      }
    }
    return [...set];
  }

  private observeForVideo(scrobble = true): void {
    if (scrobble) this.waitingForScrobbleVideo = true;
    if (this.videoObserver) return;
    // Debounce: findVideo() scans the whole document, and on a busy SPA (React
    // re-renders, ad/carousel churn) the subtree observer fires constantly — an
    // unthrottled scan here saturated the main thread ("page not responding"),
    // and on a landing page whose only <video> is a muted background trailer
    // (excluded by findVideo) it never stops. A short debounce keeps it cheap.
    const check = () => {
      this.videoObserverTimer = null;
      if (this.findVideo()) {
        this.videoObserver?.disconnect();
        this.videoObserver = null;
        this.ensureHistory();
        if (this.waitingForScrobbleVideo) {
          this.waitingForScrobbleVideo = false;
          void this.ensurePlaying();
        }
      }
    };
    this.videoObserver = new MutationObserver(() => {
      if (this.videoObserverTimer) return;
      this.videoObserverTimer = setTimeout(check, 400);
    });
    this.videoObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.ctx.onInvalidated(() => {
      if (this.videoObserverTimer) clearTimeout(this.videoObserverTimer);
      this.videoObserver?.disconnect();
    });
  }

  /** Show a stop's status (its reply, or the reply with a follow-up merged in). */
  private reportStop(stop: { reply: ScrobbleReply; media: ParsedMedia; tracker: Tracker }): void {
    // We still tell the tracker to stop the outgoing episode, but the scrobble call
    // is async, so by the time it replies we may have shown the episode prompt
    // (tearing down S1E2 to ask which episode a "?play=true" URL is on) or, in the
    // top frame, navigated away entirely (badge cleared). In either case this late
    // reply must not re-show the old status. (isTop-gated: an iframe player never
    // sets badgeActive, so it must keep reporting its own normal stops.)
    if (this.episodeAwaiting || (this.isTop && !this.badgeActive)) return;
    const { reply, media, tracker } = stop;
    void sendMessage(
      "reportScrobble",
      statusFromReply("stop", reply, media, reply.primaryTracker ?? tracker),
    );
  }

  /** Local observation never resolves a tracker or attaches a ScrobbleController. */
  private ensureHistory(media = this.localMedia, video = this.findVideo()): void {
    if (!media) return;
    const key = mediaKey(media);
    if (this.history && this.historyKey === key && this.historyVideo === video) return;
    this.teardownHistory();
    if (!video) {
      this.observeForVideo(false);
      return;
    }
    const abort = new AbortController();
    this.historyAbort = abort;
    this.historyVideo = video;
    this.historyKey = key;
    const history = new HistoryRecorder(
      video,
      media,
      location.hostname,
      this.watchedThreshold,
      (checkpoint) => {
        void sendMessage("recordHistory", checkpoint).catch(() => {
          console.warn("[TMSync] Local history checkpoint could not be saved");
        });
      },
    );
    this.history = history;
    this.playback.observe(
      video,
      (event) => {
        switch (event) {
          case "play":
            history.start();
            break;
          case "pause":
            if (!video.ended) history.pause();
            break;
          case "ended":
            history.stop(true);
            break;
          case "seeking":
          case "seeked":
          case "ratechange":
            history.discontinuity();
            break;
          case "timeupdate":
            history.tick();
            break;
          case "pagehide":
            history.stop();
            break;
        }
      },
      abort.signal,
    );
    if (!video.paused && !video.ended) history.start();
  }

  private startSession(video: HTMLVideoElement, media: ParsedMedia): void {
    this.teardownScrobble();
    this.ensureHistory(media, video);
    const history = this.history;
    const abort = new AbortController();
    this.abort = abort;
    this.currentVideo = video;
    this.currentKey = mediaKey(media);
    const tracker = this.tracker;
    const trackers = this.trackers;
    const watchedThreshold = this.watchedThreshold;
    const controller = new ScrobbleController(
      video,
      (action, progress) => {
        this.lastAction = action;
        void sendMessage("scrobble", {
          historySessionId: history?.sessionId,
          action,
          media,
          progress,
          tracker,
          trackers,
          watchedThreshold,
        }).then((reply) => {
          if (action === "stop") {
            const early = this.earlyFollowUp;
            this.earlyFollowUp = null;
            const merged =
              early && mediaKey(early.media) === mediaKey(media)
                ? mergeFollowUp(reply, early.outcomes)
                : reply;
            this.lastStop = { reply: merged, media, tracker };
            this.reportStop(this.lastStop);
            return;
          }
          // MULTI-TRACK: the badge names whichever tracker the reply's top-level
          // fields describe (the native one, or the first enabled if native is off).
          void sendMessage(
            "reportScrobble",
            statusFromReply(action, reply, media, reply.primaryTracker ?? tracker),
          );
        });
        if (action === "stop") void sendMessage("endSession", { media, progress });
        else void sendMessage("updateProgress", progress);
      },
      this.watchedThreshold,
    );
    this.controller = controller;

    let lastPersist = 0;
    this.playback.observe(
      video,
      (event) => {
        if (event === "play") controller.play();
        if (event === "pause") controller.pause();
        if (event === "ended") controller.ended();
        if (event === "pagehide") controller.leave();
        if (event !== "timeupdate") return;
        // Commit to history the moment playback crosses the threshold — no pause
        // or `ended` required. Cheap + idempotent (one stop per session).
        controller.progressTick();
        const now = Date.now();
        if (now - lastPersist < PROGRESS_PERSIST_MS) return;
        lastPersist = now;
        void sendMessage("updateProgress", controller.progress());
      },
      abort.signal,
    );

    // If playback is already underway when we attach (late injection), kick a start.
    if (!video.paused && !video.ended) controller.play();
  }

  /**
   * Swap the recipe list live and re-evaluate — no page reload. Called when the
   * user saves/edits/deletes a recipe in the picker (the content script watches the
   * recipe store). It restarts the playing session, so the caller calls it only
   * when the list changed.
   */
  updateRecipes(recipes: Recipe[]): void {
    this.recipes = recipes;
    this.lastPublishedKey = null;
    this.teardownSession();
    void this.reconcile();
  }

  /**
   * Best-effort: while we're still missing the title/episode, poke the player with
   * a synthetic pointer/mouse move so a hover-gated control bar (e.g. aether.bar's
   * `S1 - E5`) renders WITHOUT the user having to move their mouse. Bounded per
   * session; a re-extract follows shortly after. Some players ignore untrusted
   * events — then the body observer still catches it on the user's first hover.
   */
  private maybeNudgeForMetadata(): void {
    if (!this.awaitingMetadata || this.metadataNudges >= 6) return;
    const video = this.currentVideo ?? this.findVideo();
    if (!video) return;
    this.metadataNudges++;
    const r = video.getBoundingClientRect();
    const opts = {
      bubbles: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    video.dispatchEvent(new MouseEvent("pointermove", opts));
    video.dispatchEvent(new MouseEvent("mousemove", opts));
    // Re-extract once the bar has had a moment to render; keep nudging if needed.
    setTimeout(() => void this.reconcile(), 400);
  }

  private teardownSession(): void {
    this.teardownHistory();
    this.teardownScrobble();
    this.readyPublishedKey = null;
    this.lastPublishedKey = null;
    this.publicationVersion++;
    this.waitingForScrobbleVideo = false;
    this.videoObserver?.disconnect();
    this.videoObserver = null;
    if (this.videoObserverTimer) clearTimeout(this.videoObserverTimer);
    this.videoObserverTimer = null;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private teardownHistory(): void {
    this.history?.stop();
    this.history = null;
    this.historyAbort?.abort();
    this.historyAbort = null;
    this.historyVideo = null;
    this.historyKey = null;
  }

  private teardownScrobble(): void {
    this.metadataNudges = 0;
    // Emit a stop for the outgoing session (SPA episode swap, nav away) before
    // dropping its listeners. ScrobbleController.leave() is idempotent.
    this.controller?.leave();
    this.controller = null;
    if (this.abort) {
      this.abort.abort(); // remove this session's listeners
      this.abort = null;
    }
    this.currentVideo = null;
    this.currentKey = null;
  }
}

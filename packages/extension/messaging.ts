import type { ScoreFormat } from "@/lib/anilist/types";
import type { HistoryCheckpoint } from "@/lib/history/types";
import type {
  CourSearchOption,
  CourTracker,
  RatingLevel,
  Tracker,
  WatchedState,
} from "@/lib/tracker/types";
import type {
  ResolvedIdentity,
  ScrobbleAction,
  TraktIds,
  TraktSearchOption,
} from "@/lib/trakt/types";
import type { ParsedMedia } from "@tmsync/shared";
import { defineExtensionMessaging } from "@webext-core/messaging";

export interface ScrobbleRequest {
  historySessionId?: string;
  action: ScrobbleAction;
  media: ParsedMedia;
  /** 0–100. */
  progress: number;
  /** The recipe's primary tracker (the legacy single field). The native tracker is
   * inferred from `trackers` at scrobble time. */
  tracker: Tracker;
  /** MULTI-TRACK (docs/MULTI-TRACK.md): the full toggled set. Any tracker beyond
   * the native one is DERIVED via the anime-map crosswalk. Omitted ⇒ [tracker]
   * (native-only, unchanged behaviour). */
  trackers?: Tracker[];
  /** 0–1; the per-recipe "treat as finished here" point (AniList owns the watched decision). */
  watchedThreshold?: number;
}

/** Per-derived-tracker outcome for the badge (multi-track). `skipped` = a silent
 * crosswalk miss (not an error — the item just isn't anime / isn't mapped). */
export interface DerivedOutcome {
  tracker: Tracker;
  ok: boolean;
  action?: "start" | "pause" | "scrobble";
  reason?: string;
  skipped?: boolean;
  completed?: boolean;
  /** Recorded nothing because this episode is already counted on the tracker. */
  info?: "already_watched";
  /** The tracker's own error text (a rate limit, a numbering mismatch), for the badge. */
  httpError?: string;
  /** Recorded after the reply (Simkl waiting out its scrobble lock). A
   * `scrobbleFollowUp` to the scrobbling frame brings the real outcome. */
  deferred?: boolean;
  resolvedTitle?: string;
  resolvedYear?: number;
  resolvedEpisodes?: number;
}

/** One tracker's standing on the current episode (see `getWatchStanding`). */
export interface WatchStanding {
  tracker: Tracker;
  /** The episode is already counted, so playing it records nothing here. */
  already: boolean;
  /** The tracker's recorded progress (episode #). */
  atEpisode: number;
  /** The entry is completed: watching again first asks "Rewatching?". */
  completed: boolean;
}

export interface ScrobbleReply {
  ok: boolean;
  /** HTTP status from the primary tracker (when a call was made). */
  status?: number;
  /** False when the title couldn't be resolved against Trakt. */
  resolved: boolean;
  /** Trakt's echoed action; "scrobble" means it was added to history. */
  action?: "start" | "pause" | "scrobble";
  /** Why a scrobble failed, for the badge. `numbering_mismatch` is the AniList
   * guardrail; `needs_rewatch` means a COMPLETED AniList cour needs a rewatch
   * confirmation before anything is written. */
  reason?:
    | "not_connected"
    | "unresolved"
    | "no_episode"
    | "numbering_mismatch"
    | "needs_rewatch"
    | "http";
  /** AniList only: this write completed the cour (drives the cour-rating prompt). */
  completed?: boolean;
  /** Benign info outcome (ok, nothing written). `already_watched` = the scraped
   * episode is at/below the tracker's recorded progress; the badge says so instead
   * of a confusing "stopped". Paired with `atEpisode` (the tracker's progress). */
  info?: "already_watched";
  atEpisode?: number;
  /** What this resolved to on Trakt (transparency for the badge). */
  resolvedTitle?: string;
  resolvedYear?: number;
  /** Total episodes on the resolved entry (AniList). 1 ⇒ a single-episode entry
   * (a movie, OVA, special, or short) — the badge drops the "E1" suffix since the
   * number is always 1 (no information). This is NOT a reliable "is a movie" signal;
   * that would be AniList `format === "MOVIE"`, which we don't fetch. */
  resolvedEpisodes?: number | null;
  /** Trakt's error body on an http failure (for diagnosis in the badge). */
  httpError?: string;
  /** MULTI-TRACK: outcomes for the DERIVED tracker(s) written this same phase,
   * so the badge can surface "Trakt ✓ · AniList ⚠ numbering". Empty/absent for a
   * single-tracker recipe. */
  derived?: DerivedOutcome[];
  /** MULTI-TRACK: which tracker these top-level fields describe (the native one, or
   * the first enabled when the native isn't recorded). Lets the badge name it
   * correctly. Absent ⇒ the recipe's own tracker. */
  primaryTracker?: Tracker;
}

export type BadgeState = "idle" | "watching" | "paused" | "scrobbled" | "stopped" | "error";

/** Per-tracker outcome for the multi-track badge. Rendered as a tinted logo on the
 * status bar + a status glyph in the Tracking panel — a structure that scales to any
 * number of trackers, unlike a concatenated "Trakt … · AniList …" string. */
export interface TrackerOutcome {
  tracker: Tracker;
  /** ok = recorded this phase; attention = needs the user (connect / numbering /
   * not found / failed); pending = enabled but nothing written yet (watching, or
   * AniList before its threshold write). */
  state: "ok" | "attention" | "pending";
  /** Short per-tracker note for the glyph tooltip + panel row, e.g. "added to
   * history", "saved", "connect", "numbering ✗". */
  note?: string;
  /** The tracker's own error text behind an `attention` note (e.g. Simkl's daily
   * limit), shown in the mark's tooltip. */
  detail?: string;
}

export interface BadgeStatus {
  state: BadgeState;
  /** e.g. "The Pixel Frontier S2E4". */
  title?: string;
  /** short human detail, e.g. "added to history" or "not connected". */
  detail?: string;
  /** MULTI-TRACK: per-tracker outcomes, present when >1 tracker is involved. The bar
   * then shows tracker logos (tinted by `state`) instead of per-tracker prose, and
   * `detail` collapses to a neutral verb ("recorded"). Absent ⇒ single-tracker, use
   * `detail`. */
  trackers?: TrackerOutcome[];
  /** Manual mode awaiting a selection — the badge shows a "pick what you're
   * watching" prompt instead of (or alongside) the status line. */
  pick?: boolean;
  /** A show page whose URL carries no episode (e.g. a "?play=true" deep link) —
   * the badge shows a season/episode chooser so scrobbling can start. */
  needEpisode?: boolean;
  /** A recipe matched but the `<video>` lives in a cross-origin player frame that
   * isn't enabled (or whose embed host changed), so playback can't be tracked — the
   * badge points the user to enable the player frame in the popup. */
  needFrame?: boolean;
  /** An already-COMPLETED cour is being re-watched: the badge shows a
   * "rewatching?" confirmation; nothing is written until the user says yes. */
  rewatch?: boolean;
  /** The trackers that asked (answered `needs_rewatch`); confirming writes each. */
  rewatchTrackers?: Tracker[];
  /** Cour trackers only: the last write finished the cour (gates the cour-rating prompt). */
  completed?: boolean;
  /** Dismiss the badge entirely — sent when an SPA navigates away from a
   * scrobblable page so a stale "watching" badge doesn't linger. */
  hide?: boolean;
}

export interface TabMedia {
  media: ParsedMedia;
  /** The PRIMARY/native tracker this tab's item routes to. */
  tracker: Tracker;
  /** MULTI-TRACK: the full toggled set (native + derived). Omitted ⇒ [tracker]. */
  trackers?: Tracker[];
  videoSelector: string;
  /** Where the player lives: which frame should drive scrobbling. */
  frame: "auto" | "top" | "iframe";
  /** 0–1; a pause at/after this fraction is committed as a stop. */
  watchedThreshold: number;
}

export interface TraktStatus {
  connected: boolean;
  /** The redirect URI to register in the Trakt app (shown in the popup). */
  redirectUri: string;
}

/** Per-tracker resolution readout for the current item (multi-track): what each
 * enabled tracker matched, or why it didn't — powers the rate/correct UI so it can
 * show real destinations and gate actions (e.g. don't offer to rate on AniList when
 * the item isn't anime). */
export interface TrackerResolution {
  tracker: Tracker;
  resolved: boolean;
  title?: string;
  id?: number;
  /** When unresolved: "no_match" (crosswalk miss / not anime) | "ambiguous" |
   * "map_loading" (the CDN crosswalk hasn't landed yet) | "unresolved" (searched,
   * nothing) | "http". */
  reason?: string;
  /** The item's own page on the tracker, when the tracker gives one that an id
   * alone can't build (Simkl: the section of simkl.com). */
  url?: string;
}

/** The item a rating or note is for. `media` is the scraped media; `trackers` is the
 * recipe's enabled set, so the background picks the same entry the scrobble writes
 * (the crosswalk's entry for a derived tracker). */
export interface ReviewTarget {
  media: ParsedMedia;
  tracker: Tracker;
  trackers?: Tracker[];
}

/** An OAuth provider's account status (AniList, MAL: independent connections). */
export interface ProviderStatus {
  connected: boolean;
  /** The redirect URI to register in the provider's app (shown in the options page). */
  redirectUri: string;
  /** Whether a client id is configured at all (so the UI can explain if not). */
  configured: boolean;
}

/** AniList account status. */
export type AniListStatus = ProviderStatus;

/**
 * Typed content↔background↔popup contract. Background handlers are stateless and
 * read everything from storage on each call (constraint #4).
 */
export interface ProtocolMap {
  recordHistory(checkpoint: HistoryCheckpoint): boolean;
  ping(): "pong";
  getTraktStatus(): TraktStatus;
  connectTrakt(): { ok: boolean; error?: string };
  disconnectTrakt(): void;
  /** AniList account (independent of Trakt — an item routes to one, never both). */
  getAniListStatus(): AniListStatus;
  connectAniList(): { ok: boolean; error?: string };
  disconnectAniList(): void;
  /** MyAnimeList account. The UI requests MAL host access before `connectMal`. */
  getMalStatus(): ProviderStatus;
  connectMal(): { ok: boolean; error?: string };
  disconnectMal(): void;
  /** Simkl account. api.simkl.com answers CORS, so no host access is needed. */
  getSimklStatus(): ProviderStatus;
  connectSimkl(): { ok: boolean; error?: string };
  disconnectSimkl(): void;
  scrobble(req: ScrobbleRequest): ScrobbleReply;
  /** Resolve scraped media to its tracker identity WITHOUT recording — lets the
   * badge show the matched title before the user presses play (transparency). */
  resolveMedia(q: { media: ParsedMedia; tracker: Tracker }): {
    resolved: boolean;
    /** Why it didn't resolve, when the tracker needs a connection first. */
    reason?: "not_connected";
    /** The resolved tracker item id (Trakt id / AniList Media id) — lets the
     * content script key the anime crosswalk by the matched AniList entry. */
    id?: number;
    title?: string;
    year?: number;
    mediaType?: "movie" | "show";
  };
  /** MULTI-TRACK: resolve the current media on EACH enabled tracker (read-only,
   * native direct + derived via the crosswalk) so the rate/correction UI can show
   * per-tracker destinations and gate actions. */
  resolveAll(q: { media: ParsedMedia; trackers: Tracker[] }): TrackerResolution[];
  /** Force-refresh the CDN recipe list; returns how many recipes are now cached. */
  refreshRecipes(): { ok: boolean; count: number; error?: string };
  /** Build a Letterboxd-import CSV from the user's Trakt movie history, ratings
   * and reviews (rewatches included). Client-side only — the CSV is returned to
   * the page to download; nothing is sent anywhere new (constraint #6). */
  exportLetterboxd(): { ok: boolean; csv?: string; count?: number; error?: string };
  /** Register the content script for an origin the user just granted access to. */
  registerSite(origin: string): { ok: boolean; error?: string };
  unregisterSite(origin: string): { ok: boolean };
  listEnabledSites(): string[];
  /** Reconcile content-script registrations against permissions + recipes — call
   * after toggling the broad "enable all sites" grant or importing a backup, so
   * the change takes effect without a reload. */
  syncSiteRegistrations(): void;
  /** Recipe origins (from `hostnames`) the user hasn't allowed yet. Empty when the
   * broad grant is held. */
  pendingSites(): string[];
  /** Whether the broad "enable all sites" grant is held. Content scripts can't read
   * `permissions.contains`, so they ask the background (e.g. to suppress the
   * "enable the player frame" hint when the catch-all already covers every frame). */
  hasAllSitesGrant(): boolean;

  // --- per-tab session coordination (top frame ↔ player iframe ↔ background) ---
  /** The recipe-matching frame publishes the media so a cross-origin player iframe can pick it up. */
  publishMedia(data: TabMedia): void;
  /** The media the top frame published for a tab. A content script omits `tabId`
   * (its own tab is inferred from the sender); the popup passes the active tabId. */
  getTabMedia(q?: { tabId?: number }): TabMedia | null;
  /** The viewer's watched progress for this tab's resolved show — "last watched /
   * next up" for the popup. Resolves (cached) then reads the routed tracker; null
   * for movies, unresolved titles, or when not connected. */
  getWatchedState(q?: { tabId?: number }): WatchedState | null;
  /** Where each enabled tracker stands on the tab's current episode, BEFORE playing:
   * already counted (a cour tracker never re-counts it), or a completed entry (a
   * rewatch needs confirming). Each derived tracker is checked on its own entry. */
  getWatchStanding(q?: { tabId?: number }): WatchStanding[];
  /** Playing frame reports latest progress (reconciliation safety net). */
  updateProgress(progress: number): void;
  /** Playing frame signals a clean stop of `media` at `progress` so the background
   * won't re-reconcile it. A late stop for another media (the outgoing episode) is
   * ignored. */
  endSession(stop: { media: ParsedMedia; progress: number }): void;
  /** Playing frame reports scrobble state; background relays to the top frame's badge. */
  reportScrobble(status: BadgeStatus): void;
  /** Top frame reports cross-origin iframe origins it has seen (accumulated for the popup). */
  reportFrameOrigins(origins: string[]): void;
  /** Background → top frame: update the badge. */
  scrobbleStatus(status: BadgeStatus): void;

  // --- manual mode (sites with no readable title) ---
  /** The remembered manual pick for (recipeId, pageKey), or null. */
  getManualMedia(q: { recipeId: string; pageKey: string }): ParsedMedia | null;
  /** Set what's playing on a manual site: saves a correction (so it resolves to
   * the exact picked Trakt entry) + remembers it by (recipeId, pageKey), then
   * re-resolves the tab so scrobbling starts. */
  setManualMedia(q: {
    recipeId: string;
    pageKey: string;
    media: ParsedMedia;
    identity: ResolvedIdentity;
    /** Popup supplies the active tabId; a content script omits it. */
    tabId?: number;
  }): { ok: boolean };
  /** The remembered manual season/episode for this tab's URL, or null. Read via
   * the background because the override lives in `session` storage, which
   * content scripts cannot access directly. */
  getEpisodeOverride(): { season: number; episode: number } | null;
  /** Drop the override stored for a specific URL — sent by the matcher frame when
   * it navigates away from an S/E-less URL, so a later return re-prompts instead
   * of silently reusing a stale episode (the URL can resume a different one). */
  clearEpisodeOverride(q: { url: string }): void;
  /** Stop this tab's scrobble session and tell every frame to re-evaluate. The
   * matcher frame sends this when it can no longer determine what's playing (an
   * S/E-less URL with no override) so a stale player-iframe session can't keep
   * the badge — and Trakt — on the previous episode. */
  stopTabSession(): void;
  /** The user supplied the season/episode for a show URL that carries none
   * (e.g. a "?play=true" deep link). Persists it keyed by the tab's URL and
   * re-resolves the tab so scrobbling starts. */
  setEpisode(q: { season: number; episode: number; tabId?: number }): { ok: boolean };
  /** Matcher frame publishes (or clears) this tab's manual context so the badge
   * knows which recipe + page key a pick belongs to. */
  publishManualContext(ctx: { recipeId: string; pageKey: string } | null): void;
  /** Badge/popup reads the manual context for a tab (popup passes the active tabId). */
  getManualContext(q?: { tabId?: number }): { recipeId: string; pageKey: string } | null;

  /** TMDB/IMDB ids for a Trakt show/movie by its URL slug — app.trakt.tv's DOM
   * carries no external-id links (unlike the classic site), so its quick links
   * resolve `{tmdb}` this way instead of scraping it. Null on any failure. */
  traktIdsForSlug(q: { type: "movie" | "show"; slug: string }): TraktIds | null;

  // --- corrections (fix a wrong match) ---
  /** Free-text Trakt search for the correction picker. */
  searchTrakt(q: { query: string; type?: "movie" | "show" }): TraktSearchOption[];
  /** Persist a correction for the scraped media and re-resolve the tab. */
  saveCorrection(data: { media: ParsedMedia; identity: ResolvedIdentity; tabId?: number }): void;
  /** Free-text search for a cour tracker's fix-match panel. */
  searchCour(q: { tracker: CourTracker; query: string }): CourSearchOption[];
  /** Pin (or block, via `id: null`) a cour tracker's entry for this item: a
   * tmdb-keyed crosswalk pin when the page has a tmdb id, plus a title correction.
   * Then re-resolve the tab. */
  setCourMatch(q: {
    tracker: CourTracker;
    media: ParsedMedia;
    id: number | null;
    tabId?: number;
  }): { ok: boolean; error?: string };
  /** Clear that pin (or "Not on <tracker>"): back to the automatic match. Then
   * re-resolve the tab. */
  resetCourMatch(q: { tracker: CourTracker; media: ParsedMedia; tabId?: number }): {
    ok: boolean;
  };
  /** Background → the scrobbling frame: the outcome of trackers a stop recorded
   * after its reply (`DerivedOutcome.deferred`). */
  scrobbleFollowUp(q: { media: ParsedMedia; outcomes: DerivedOutcome[] }): void;
  /** Background → frames: a correction landed, re-resolve the current session. */
  recheck(): void;

  /** Confirm a rewatch of an already-COMPLETED cour (the badge prompt).
   * Switches the entry to REPEATING and records this episode; on the final
   * episode it re-completes and bumps the repeat count. */
  confirmRewatch(q: {
    media: ParsedMedia;
    /** The cour trackers that asked (`BadgeStatus.rewatchTrackers`). */
    trackers: Tracker[];
    /** The recipe's enabled set, so a derived tracker confirms the crosswalk's entry. */
    enabled: Tracker[];
    tabId?: number;
  }): {
    ok: boolean;
    error?: string;
    completed?: boolean;
  };

  // --- ratings & notes (Trakt: managed public comment per level; AniList: cour entry) ---
  /** Which rating levels the routed tracker supports for this media, plus the
   * AniList score format when relevant — so the badge renders only valid
   * affordances (Trakt: show/season/episode; AniList: a single "cour"). */
  getRatingMeta(q: { media: ParsedMedia; tracker: Tracker }): {
    levels: RatingLevel[];
    scoreFormat?: ScoreFormat;
  };
  /** Current rating (1–10) and note for an item at a level, from the local mirror. */
  getReview(q: ReviewTarget & { level: RatingLevel }): {
    rating: number | null;
    note: { text: string; spoiler: boolean } | null;
  };
  /** Set a 1–10 rating (AniList: stored as scoreRaw = rating×10 on the cour entry). */
  rateItem(q: ReviewTarget & { level: RatingLevel; rating: number }): {
    ok: boolean;
    error?: string;
  };
  /** Remove the rating. */
  unrateItem(q: ReviewTarget & { level: RatingLevel }): {
    ok: boolean;
    error?: string;
  };
  /** Create or edit the single note (Trakt: ≥5 words, public; AniList: private cour note). */
  saveNote(q: ReviewTarget & { level: RatingLevel; text: string; spoiler: boolean }): {
    ok: boolean;
    error?: string;
  };
  /** Delete the note. */
  deleteNote(q: ReviewTarget & { level: RatingLevel }): {
    ok: boolean;
    error?: string;
  };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

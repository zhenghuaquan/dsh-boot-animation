/**
 * @dsh-external/dsh-boot-animation - browser half.
 *
 * Plays the boot video full-frame in two cases:
 *   1. any conversation the user PINNED as an intro session, EVERY time it is
 *      opened (those are the "professional work mode" conversations they return
 *      to). There is no limit on how many can be pinned;
 *   2. a brand new, still-empty conversation, once per conversation.
 *
 * The pin exists because a specific conversation cannot be identified by name
 * from the client: session titles are not part of the session summary the client
 * holds, and asking a human for a session UUID is not a workflow. So the sidebar
 * footer gets one small button that pins (or unpins) whatever conversation is
 * open, and the library dialog carries the management list where a pin can be
 * dropped again without having to open that conversation first.
 *
 * Seating:
 *   - `shell.overlay`        the frame-wide floating layer for the animation
 *   - `sidebar.footer.action` the small pin toggle beside Settings
 * Both are list slots, so each is an added cell, never a replacement.
 *
 * Which session is current comes from the ui-session service. Its
 * `adapter.current` store resolves to `{ key, hooks, keyedHooks, props }`, i.e.
 * `props.sessionId` and `hooks.session`. A brand new conversation is
 * `hooks.session.blankBit === true` (`blank` belongs to another package's
 * projected summary and is not on this snapshot).
 *
 * The pin management list needs the conversation TITLES, which that
 * current-binding snapshot cannot carry — it describes exactly one conversation.
 * The roster reaches a slot component as the `useSessions` hook prop, part of
 * the standard kit every slot entry is rendered with (root sources become
 * `use<Name>` props), and a row is `{ id, title }`. It is read DEFENSIVELY: the
 * prop missing costs a fallback to the raw session id, never a crash.
 *
 * Browser policy, honestly: audible autoplay needs the user to have interacted
 * with the page. Opening a conversation IS such an interaction (a click in the
 * sidebar precedes this overlay), so the overlay tries to start WITH SOUND, as
 * the default setting says, and only falls back to muted playback when the
 * browser refuses. A click anywhere on the overlay is the skip gesture, and
 * nothing else: the old click-to-unmute job is gone, because one gesture cannot
 * both start the sound and dismiss the thing you want to hear.
 */

import type { ReactElement } from 'react'
import { createElement as h, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** Slot service for both seats, ui-session for the current conversation. */
export const inject = ['slots', 'uiSession']

/**
 * Plays the active clip.
 *
 * The src is a CONSTANT. It used to carry `#<activeId>` so the element would
 * reload when the library selection changed, but the id arrives from an async
 * fetch, so the src changed a moment AFTER the overlay opened — mid-playback.
 * A src change restarts the media load, and the play() effect does not re-run
 * on it, so the result was a black frame that looked like "the video will not
 * load". The fragment bought nothing: the route resolves the active file on
 * every request, so the next time the overlay opens it is already the new clip.
 */
const VIDEO_URL = '/dsh-boot-animation/boot.mp4'
const LIST_URL = '/dsh-boot-animation/videos.json'
const SELECT_URL = '/dsh-boot-animation/select'
const SEEN_KEY = 'dsh-boot-animation:seen'
/** JSON array of pinned session ids. A bare id here is the single-pin legacy shape. */
const PIN_KEY = 'dsh-boot-animation:pinned'
const FIT_KEY = 'dsh-boot-animation:fit'
const SOUND_KEY = 'dsh-boot-animation:sound'
const MAX_SEEN = 80
/** Never let a stalled video trap the user behind the overlay. */
const STALL_TIMEOUT_MS = 25000
/**
 * How long after the overlay opens a click is ignored.
 *
 * The click that opened the conversation is the reason the overlay exists, and a
 * DOUBLE click on a sidebar row delivers its second click a couple of hundred
 * milliseconds later — onto an overlay that now covers the window, which would
 * skip the animation the user just asked for before a single frame showed.
 */
const SKIP_GRACE_MS = 400

/**
 * The clip's content key, fetched once so the media URL can carry `?v=`.
 *
 * The route is constant but the BYTES behind it are not: this session alone
 * served three different files under `/boot.mp4`. A media cache keyed by that
 * URL, revalidating range requests one at a time, can end up holding a spliced
 * file — and a spliced MP4 does not error, it simply never paints. Pinning the
 * content key into the URL gives every distinct clip its own cache entry, so a
 * stale one cannot exist, and lets the host answer `immutable` rather than
 * `no-cache` (which is what makes the NEXT play instant instead of a round trip).
 *
 * Resolved BEFORE any overlay opens and never during playback: a src that
 * changes after mount restarts the media load while the play() effect does not
 * re-run, which is the black frame this plugin already fixed once.
 */
let activeVersion: string | null = null
let versionStarted = false
function resolveActiveVersion(): void {
  if (versionStarted) return
  versionStarted = true
  void (async () => {
    try {
      const response = await fetch(LIST_URL, { cache: 'no-store' })
      if (!response.ok) return
      const data = (await response.json()) as { activeVersion?: unknown }
      const version = data.activeVersion
      if (typeof version !== 'string' || version === '') return
      activeVersion = version
      log('active version', version)
      // Warm the media cache while nobody is waiting for it: with a versioned
      // URL the host marks this immutable, so the later <video> request is
      // answered from the local copy instead of the network.
      await fetch(videoSrc(), { cache: 'force-cache' })
      notify('media prefetched', videoSrc())
    } catch (error: unknown) {
      notify('prefetch failed', String(error))
    }
  })()
}

/** The URL to play, carrying the content key when it is already known. */
function videoSrc(): string {
  return activeVersion === null ? VIDEO_URL : VIDEO_URL + '?v=' + encodeURIComponent(activeVersion)
}

/**
 * How the clip meets the window: 'cover' fills it and crops the overflow,
 * 'contain' shows the whole frame and leaves black bars. Cover by default,
 * because a splash that leaves bars on a normal monitor reads as broken.
 * Read per overlay open, like the clip choice, so a change lands next playback.
 */
type Fit = 'cover' | 'contain'
function readFit(): Fit {
  try {
    return window.localStorage.getItem(FIT_KEY) === 'contain' ? 'contain' : 'cover'
  } catch {
    return 'cover'
  }
}
function writeFit(fit: Fit): void {
  try {
    window.localStorage.setItem(FIT_KEY, fit)
  } catch {
    /* private mode: it simply does not persist */
  }
}

/**
 * Whether the clip plays with sound. ON unless the user turned it off.
 *
 * Only an explicit 'off' disables it: a missing key (a fresh install, a browser
 * that refuses storage) reads as on, which is what "音频默认为打开" means.
 */
type Sound = 'on' | 'off'
function readSound(): Sound {
  try {
    return window.localStorage.getItem(SOUND_KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'on'
  }
}
function writeSound(sound: Sound): void {
  try {
    window.localStorage.setItem(SOUND_KEY, sound)
  } catch {
    /* private mode: it simply does not persist */
  }
}

/** Set to true to narrate every decision the plugin makes in the browser console. */
const DEBUG = false
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    .join(' ')
}
function narrate(text: string): void {
  try {
    console.log('[dsh-boot-animation] ' + text)
  } catch {
    /* console unavailable */
  }
}
function log(...args: unknown[]): void {
  if (!DEBUG) return
  narrate(formatArgs(args))
}

/**
 * The always-on subset. A black overlay reports nothing by itself — no network
 * error, no thrown exception, just a video element that never paints — so the
 * four things needed to diagnose one from the outside are logged unconditionally:
 * which URL the element actually used, when the first frame arrived, when the
 * element errored and with which code, and when the stall watchdog gave up.
 * They are one line each and only fire on a play, so the noise is bounded.
 */
function notify(...args: unknown[]): void {
  narrate(formatArgs(args))
}

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function hasPlayed(sessionId: string): boolean {
  return readSeen().includes(sessionId)
}

function markPlayed(sessionId: string): void {
  try {
    const seen = readSeen()
    if (!seen.includes(sessionId)) seen.push(sessionId)
    while (seen.length > MAX_SEEN) seen.shift()
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode: it simply replays next time */
  }
}

function readPinned(): string[] {
  try {
    const raw = window.localStorage.getItem(PIN_KEY)
    if (raw === null || raw === '') return []
    // The single-pin version stored a BARE session id under this same key. A
    // bare id is not a JSON array, and that is the whole migration: it is read
    // as a one-element list, and the next write stores it in the new shape. No
    // version field, no startup migration step, no pin lost on upgrade.
    if (!raw.startsWith('[')) return [raw]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids = parsed.filter((value): value is string => typeof value === 'string' && value !== '')
    // De-duplicate: two entries for one conversation would show two rows in the
    // management list and two identical toggles for one pin.
    return [...new Set(ids)]
  } catch {
    return []
  }
}

/**
 * The pin list, written back and announced.
 *
 * Both React roots that care live in DIFFERENT slots (the sidebar button and the
 * overlay's dialog), so they cannot share state through props. They subscribe
 * here instead: a removal in the management list has to turn the sidebar button
 * off in the same click, and a pin from the sidebar has to appear in the list.
 */
const pinListeners = new Set<() => void>()

function writePinned(ids: string[]): void {
  try {
    if (ids.length === 0) window.localStorage.removeItem(PIN_KEY)
    else window.localStorage.setItem(PIN_KEY, JSON.stringify(ids))
  } catch {
    /* private mode: the pin simply does not persist */
  }
  // Still announce: in-memory state has to stay right even when storage refused.
  for (const listener of [...pinListeners]) {
    try {
      listener()
    } catch {
      /* one stale subscriber must not break the others */
    }
  }
}

/** The live pin list, re-read on every change from either root. */
function usePinned(): string[] {
  const [pinned, setPinned] = useState<string[]>(() => readPinned())
  useEffect(() => {
    const refresh = () => setPinned(readPinned())
    pinListeners.add(refresh)
    // Re-read once after subscribing: storage may have changed between the
    // initial state and this effect.
    refresh()
    // Another DSH window on the same origin writes the same key; its change
    // arrives as a storage event rather than through `pinListeners`.
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === PIN_KEY) refresh()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      pinListeners.delete(refresh)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return pinned
}

/** Add the conversation when it is not pinned, drop it when it is. */
function togglePin(pinned: string[], sessionId: string): string[] {
  return pinned.includes(sessionId) ? pinned.filter((id) => id !== sessionId) : [...pinned, sessionId]
}

const STYLE_ID = 'dsh-boot-animation-style'
const CSS = `
.dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
  display:flex;align-items:center;justify-content:center;
  pointer-events:auto;cursor:pointer;overflow:hidden}
.dba-video{width:100%;height:100%;object-fit:contain;background:#000;display:block}
/* The ONLY difference between the fit modes is object-fit.
   Do not "harden" this with position/inset changes: the bar fix does not need
   them, and an overlay that rendered correctly under flex + percentage sizing
   went fully black in the real app the one time the layout mechanics were
   rewritten for no reason. Minimal change, or you trade a cosmetic defect for
   a functional one.
   NOTE: never put a backtick in this block — the whole sheet is a template
   literal, and one backtick ends it. scripts/check-css-template.mjs enforces it. */
.dba-video.dba-cover{object-fit:cover;object-position:center}
/* No .dba-skip rule: skipping is a click anywhere on .dba-root, so there is no
   button to style. Do not reintroduce one — a visible control in the corner is
   exactly what the click-to-skip gesture replaced. */
.dba-hint{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);
  z-index:2;color:rgba(255,255,255,.82);font-size:13px;letter-spacing:.06em;
  font-family:inherit;text-shadow:0 1px 8px rgba(0,0,0,.9);
  animation:dba-breathe 2.4s ease-in-out infinite;white-space:nowrap}
@keyframes dba-breathe{0%,100%{opacity:.55}50%{opacity:1}}
.dba-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:2;color:rgba(255,255,255,.88);font-size:14px;letter-spacing:.04em;
  font-family:inherit;text-align:center;max-width:78vw;
  background:rgba(0,0,0,.46);border-radius:10px;padding:10px 18px;
  text-shadow:0 1px 10px rgba(0,0,0,.9)}
.dba-pin{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:0;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-text-secondary,#888);
  font-size:14px;line-height:1;font-family:inherit;position:relative}
.dba-pin:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-text-primary,#191919)}
.dba-pin.dba-pin-on{color:#07c160;background:rgba(7,193,96,.14)}
/* How many conversations are pinned. The icon keeps its 28px hit area, so the
   badge sits on top of it rather than widening the button. */
.dba-pin-count{position:absolute;top:-2px;right:-3px;min-width:14px;height:14px;
  padding:0 3px;box-sizing:border-box;border-radius:999px;background:#07c160;color:#fff;
  font-size:10px;line-height:14px;text-align:center;font-weight:600;
  pointer-events:none}
/* The pinned-conversation section of the library dialog. */
.dba-sec{margin:16px 0 6px;font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-text-primary,#191919)}
.dba-sec .dba-sec-n{font-weight:400;color:var(--dsw-alias-text-secondary,#888)}
.dba-empty{padding:8px 10px;border-radius:9px;background:rgba(127,127,127,.10);
  font-size:12px;color:var(--dsw-alias-text-secondary,#777);line-height:1.5}
.dba-unpin{border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;
  border-radius:8px;padding:3px 10px;font-size:12px;font-family:inherit;cursor:pointer;
  white-space:nowrap}
.dba-unpin:hover{background:rgba(210,74,67,.12);border-color:rgba(210,74,67,.45);color:#c0392b}
/* A pinned row is information plus an explicit 移除 button, not a click target:
   drop the pointer affordance .dba-item carries. */
.dba-pinrow{cursor:default}
.dba-veil{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.46);
  display:flex;align-items:center;justify-content:center;padding:24px}
.dba-lib{width:min(560px,100%);max-height:min(76vh,640px);overflow:auto;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#191919);
  border:1px solid rgba(127,127,127,.28);border-radius:14px;padding:18px 18px 14px;
  box-shadow:0 18px 60px rgba(0,0,0,.34);font-family:inherit;
  font-size:13px;line-height:1.55}
.dba-lib h3{margin:0 0 4px;font-size:15px;font-weight:600}
.dba-lib p{margin:0 0 12px;color:var(--dsw-alias-text-secondary,#777);font-size:12.5px}
.dba-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;
  cursor:pointer;border:1px solid transparent}
.dba-item:hover{background:rgba(127,127,127,.12)}
.dba-item.dba-cur{border-color:rgba(7,193,96,.55);background:rgba(7,193,96,.10)}
.dba-item .dba-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dba-badge{font-size:11px;padding:1px 7px;border-radius:999px;
  background:rgba(127,127,127,.18);color:var(--dsw-alias-text-secondary,#777);white-space:nowrap}
.dba-badge.dba-b-sel{background:rgba(7,193,96,.16);color:#07974b}
.dba-badge.dba-b-warn{background:rgba(210,120,40,.18);color:#b46214;cursor:help}
.dba-meta{font-size:11.5px;color:var(--dsw-alias-text-secondary,#999);white-space:nowrap}
.dba-mark{width:16px;text-align:center;color:#07c160;font-weight:700}
.dba-dir{margin:12px 0 0;padding:9px 10px;border-radius:9px;background:rgba(127,127,127,.10);
  font-size:11.5px;color:var(--dsw-alias-text-secondary,#777);word-break:break-all}
.dba-dir code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--dsw-alias-text-primary,#333)}
.dba-bar{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.dba-fit{display:flex;align-items:center;gap:8px;margin-top:12px;
  font-size:12px;color:var(--dsw-alias-text-secondary,#777)}
.dba-btn.dba-btn-on{border-color:rgba(7,193,96,.6);background:rgba(7,193,96,.12);color:#07974b}
.dba-btn.dba-btn-preview{border-color:rgba(7,193,96,.55);color:#07974b;font-weight:600}
.dba-btn.dba-btn-preview:hover{background:rgba(7,193,96,.12)}
.dba-btn{border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;
  border-radius:8px;padding:5px 14px;font-size:12.5px;font-family:inherit;cursor:pointer}
.dba-btn:hover{background:rgba(127,127,127,.14)}
.dba-msg{margin-top:10px;font-size:12px;min-height:16px;color:var(--dsw-alias-text-secondary,#777)}
.dba-msg.dba-ok{color:#07974b}
.dba-msg.dba-err{color:#d24a43}
`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

type CurrentStore = {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

/** Resolved ui-session binding as the built-in source publishes it. */
type Binding = {
  key?: unknown
  hooks?: {
    session?: {
      /** The snapshot's own "this conversation is still empty" flag. */
      blankBit?: unknown
    }
  }
  keyedHooks?: unknown
  props?: { sessionId?: unknown }
}

const noopSubscribe = () => () => {}

/** Subscribe to the current-conversation store, tolerating its absence. */
function useCurrentSession(store: CurrentStore | null): {
  sessionId: string | null
  isNewConversation: boolean
} {
  const binding = useSyncExternalStore(
    store === null ? noopSubscribe : store.subscribe,
    store === null ? () => null : store.getSnapshot,
  ) as Binding | null
  const sessionId = typeof binding?.props?.sessionId === 'string' ? binding.props.sessionId : null
  return { sessionId, isNewConversation: binding?.hooks?.session?.blankBit === true }
}

function BootOverlay({
  store,
  previewAt = 0,
}: {
  store: CurrentStore | null
  /** Bumped by the library's preview button to force a play right now. */
  previewAt?: number
}): ReactElement | null {
  ensureStyle()

  const { sessionId, isNewConversation } = useCurrentSession(store)
  // Decided per open, so a change in the library panel lands on the next play.
  const fit = readFit()

  const [showing, setShowing] = useState(false)
  /**
   * True only when the browser refused to start the clip at all — audible AND
   * muted. It no longer offers a click-to-play recovery, because a click is the
   * skip gesture now; it just swaps the hint for an explanation.
   */
  const [blocked, setBlocked] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'playing' | 'stalled' | 'error'>('loading')
  /**
   * Frozen at mount, deliberately: `videoSrc()` reads a value that resolves from
   * an async fetch, and letting the src change after mount is exactly the black
   * frame bug this plugin already paid for once (see the note above VIDEO_URL).
   */
  const [src] = useState(videoSrc)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const closedRef = useRef(false)
  const lastSessionRef = useRef<string | null>(null)
  /** When the current play started, so an opening double-click cannot skip it. */
  const openedAtRef = useRef(0)

  const close = useCallback(() => {
    closedRef.current = true
    setShowing(false)
    const video = videoRef.current
    if (video !== null) {
      try {
        video.pause()
      } catch {
        /* already stopped */
      }
    }
    if (document.fullscreenElement !== null && document.exitFullscreen !== undefined) {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  const open = useCallback(() => {
    closedRef.current = false
    setBlocked(false)
    openedAtRef.current = performance.now()
    setShowing(true)
  }, [])

  /**
   * The whole skip gesture: a click anywhere on the overlay, video included.
   *
   * The video used to stop propagation so that a click on the picture reached
   * the unmute/fullscreen handler; with one click meaning "skip", a click that
   * landed on the video would be the one click that did nothing, so that guard
   * is gone and every click bubbles here.
   */
  const skip = useCallback(() => {
    if (performance.now() - openedAtRef.current < SKIP_GRACE_MS) {
      log('click ignored: still inside the open grace window')
      return
    }
    log('click anywhere: skipping')
    close()
  }, [close])

  // Fire on every ENTRY into a conversation, not on every re-render.
  useEffect(() => {
    if (sessionId === null) return
    const entered = lastSessionRef.current !== sessionId
    lastSessionRef.current = sessionId
    if (!entered) return

    // Read fresh from storage rather than from component state: which
    // conversation is current changes here, and the pin list can have been
    // edited in the management list since the last render.
    const pinned = readPinned()
    if (pinned.includes(sessionId)) {
      // A designated conversation: every time it is opened.
      log('pinned session opened', sessionId)
      open()
      return
    }
    if (isNewConversation && !hasPlayed(sessionId)) {
      markPlayed(sessionId)
      log('new conversation', sessionId)
      open()
    }
  }, [sessionId, isNewConversation, open])

  // An explicit preview from the library. This exists because the normal trigger
  // is deliberately narrow — a NEW conversation plays once, and only a PINNED one
  // replays — so "I switched the clip and refreshed and the other one never
  // showed" was the expected behaviour of a design with no way to check your
  // choice. A preview button removes that guesswork.
  useEffect(() => {
    if (previewAt === 0) return
    log('preview requested', previewAt)
    open()
  }, [previewAt, open])

  // Start playback explicitly: relying on the autoplay attribute alone is
  // fragile, and a refused play() has to surface as a readable state.
  //
  // Sound is ON by default, so the FIRST attempt is deliberately unmuted: the
  // click that opened this conversation counts as the user interaction audible
  // autoplay waits for. When the browser still refuses (storage disabled, a
  // stricter policy, an iframe without allow="autoplay"), the element is not
  // left stopped — the same play() is retried muted, which is always allowed, so
  // the animation plays silently instead of freezing on the first frame. There
  // is deliberately no click-to-unmute retry: the only gesture left is skip.
  useEffect(() => {
    if (!showing) return undefined
    const video = videoRef.current
    if (video === null) return undefined
    const wantedSound = readSound() === 'on'
    const openedAt = performance.now()
    /** One line that carries everything a black-frame report needs. */
    const report = (label: string): void =>
      notify(label, {
        ms: Math.round(performance.now() - openedAt),
        readyState: video.readyState,
        networkState: video.networkState,
        src: video.currentSrc || video.src,
      })
    const onPlaying = (): void => {
      setPhase('playing')
      report('first frame painted')
    }
    video.addEventListener('playing', onPlaying)

    const start = (muted: boolean): Promise<void> => {
      video.muted = muted
      const attempt = video.play()
      return attempt !== undefined && typeof attempt.then === 'function' ? attempt : Promise.resolve()
    }

    start(!wantedSound).then(
      () => log('play started', { muted: !wantedSound }),
      (error: unknown) => {
        if (!wantedSound) {
          log('play rejected', String(error))
          setBlocked(true)
          return
        }
        notify('audible autoplay refused, retrying muted', String(error))
        start(true).then(
          () => log('playing muted instead'),
          (second: unknown) => {
            log('muted play rejected too', String(second))
            setBlocked(true)
          },
        )
      },
    )

    const guard = window.setTimeout(() => {
      if (!closedRef.current) {
        // Report BEFORE closing: a silent close leaves nothing to diagnose.
        setPhase('stalled')
        report('stalled, giving up after ' + STALL_TIMEOUT_MS + 'ms')
        close()
      }
    }, STALL_TIMEOUT_MS)
    return () => {
      video.removeEventListener('playing', onPlaying)
      window.clearTimeout(guard)
    }
  }, [showing, close])

  if (!showing) return null

  return h(
    'div',
    { className: 'dba-root', onClick: skip },
    h('video', {
      ref: videoRef,
      className: fit === 'cover' ? 'dba-video dba-cover' : 'dba-video',
      src,
      // The element starts according to the preference, but playback is always
      // driven by the effect above, which sets `muted` on the element itself
      // immediately before play(). There is no `autoPlay` attribute on purpose:
      // an attribute-started muted playback races the audible attempt, and
      // unmuting a clip the browser started muted can make it pause.
      muted: readSound() === 'off',
      playsInline: true,
      preload: 'auto',
      onEnded: close,
      onError: () => {
        const video = videoRef.current
        const code = video?.error?.code ?? 0
        const message = video?.error?.message ?? ''
        notify('video element error', { code, message, src: video?.currentSrc || src, readyState: video?.readyState ?? -1 })
        setPhase('error')
        // Do not slam the overlay shut: the reason has to stay readable for a
        // moment, and one click anywhere closes it. The stall watchdog would
        // have closed it silently, which is how a real failure looks like
        // "nothing happened".
        window.setTimeout(() => {
          if (!closedRef.current) close()
        }, 8000)
      },
    }),
    phase === 'playing'
      ? null
      : h(
          'div',
          { className: 'dba-status' },
          phase === 'error'
            ? '视频加载失败 —— 控制台有 [dsh-boot-animation] 日志'
            : phase === 'stalled'
              ? '视频加载超时'
              : '正在加载视频…',
        ),
    h(
      'div',
      { className: 'dba-hint' },
      blocked ? '浏览器拦截了自动播放 —— 点击任意位置关闭' : '点击任意位置跳过',
    ),
  )
}

/** The pin toggle that lives beside Settings at the sidebar foot. */
/** The pin toggle that lives beside Settings at the sidebar foot. */
function PinAction({ store, onOpen }: { store: CurrentStore | null; onOpen: () => void }): ReactElement {
  ensureStyle()
  const { sessionId } = useCurrentSession(store)
  const pinned = usePinned()
  const isPinned = sessionId !== null && pinned.includes(sessionId)

  const toggle = () => {
    if (sessionId === null) return
    const next = togglePin(pinned, sessionId)
    writePinned(next)
    log('pin toggled', { sessionId, pinned: next })
  }

  const title = isPinned
    ? '这个会话已设为片头会话：每次打开都会播放片头动画（点击取消）'
    : '把这个会话设为片头会话：以后每次打开它都会播放片头动画'
  const count = pinned.length
  const label = count === 0 ? title : title + '（已钉住 ' + String(count) + ' 个会话）'

  return h(
    'span',
    { className: 'dba-pin-wrap', style: { display: 'inline-flex', alignItems: 'center' } },
    h(
      'button',
      {
        type: 'button',
        className: isPinned ? 'dba-pin dba-pin-on' : 'dba-pin',
        title: label,
        'aria-label': label,
        disabled: sessionId === null,
        onClick: toggle,
      },
      isPinned ? '🎬' : '🎞',
      // How many conversations are pinned, so the list is not invisible. Only
      // shown once it is non-zero: a "0" badge would be noise.
      count === 0 ? null : h('span', { className: 'dba-pin-count' }, String(count)),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'dba-pin dba-lib-open',
        title: '片头片库：查看、切换或添加片头视频，管理已钉住的会话',
        'aria-label': '打开片头片库',
        onClick: onOpen,
      },
      '🎛',
    ),
  )
}

/** One entry as the host lists it. */
type VideoInfo = {
  id: string
  name: string
  file: string
  ext?: string
  source: string
  writable?: boolean
  bytes: number
  mtime: string
  legacy?: boolean
  faststart?: boolean
  copies?: number
  alsoAt?: string[]
  active?: boolean
}

type VideoList = {
  activeId: string | null
  activeHow?: string
  videos: VideoInfo[]
  userDir: string
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * Where a clip comes from, as one word a user can act on.
 *
 * The plugin's clips are embedded in code now, so there is a single built-in
 * kind; anything else on the list is a file the user put there.
 */
const SOURCE_LABEL: Record<string, string> = {
  yours: '你自己加的',
  embedded: '插件内置',
  env: '环境变量',
}

/**
 * The conversation roster a slot component is handed as `useSessions`.
 *
 * Only the two facts the management list needs are declared: the loading phase
 * and the row map. A row's `title` is absent for a conversation whose title is
 * not known yet (a brand new one), which is why the label falls back to the id.
 */
type SessionRow = { id?: string; title?: string }
type SessionsSnapshot = { phase?: string; byId?: Record<string, SessionRow | undefined> }
type SessionsHook = (selector: (state: SessionsSnapshot) => SessionsSnapshot) => SessionsSnapshot

/** Stable empty roster, returned when the hook prop is missing. */
const EMPTY_SESSIONS: SessionsSnapshot = { phase: 'ready', byId: {} }

/**
 * The selector handed to `useSessions`.
 *
 * Module-level so its identity never changes: `useSyncExternalStoreWithSelector`
 * memoizes per selector, and a fresh arrow on every render would throw that
 * memoization away. Selecting the whole snapshot is deliberate — the selector
 * may only read the store, never component state, so the pinned-row mapping
 * happens in the component where it can see `pinned`.
 */
const WHOLE_ROSTER = (state: SessionsSnapshot): SessionsSnapshot => state

/**
 * Read the roster defensively.
 *
 * `useSessions` is part of the standard kit the renderer synthesizes for every
 * slot entry, so it is present in practice — but a slot rendered outside the
 * root-source provider would hand us `undefined`, and a panel that throws is
 * worse than a panel showing raw ids. The substitution happens at the call site
 * and is stable for the life of the component: the prop cannot appear later.
 */
function readSessions(hook: SessionsHook | undefined, fallback: SessionsSnapshot): SessionsSnapshot {
  if (hook === undefined) return fallback
  return hook(WHOLE_ROSTER)
}

function sessionTitle(state: SessionsSnapshot, sessionId: string): string | undefined {
  const title = state.byId?.[sessionId]?.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/** One pinned conversation as the management list renders it. */
type PinnedRow = { id: string; title: string | undefined }

/**
 * The video library: every .mp4 the host can see, the active one marked, and a
 * click to switch. Adding a video stays a filesystem action — the user drops a
 * file in and presses refresh — because a browser-side upload would have to
 * carry the bytes through this route for no gain on a local-only plugin.
 *
 * It also carries the pinned-conversation management list: the only place a pin
 * can be dropped without first opening the conversation it belongs to.
 */
function VideoLibrary({
  onClose,
  onPreview,
  useSessions,
}: {
  onClose: () => void
  onPreview: () => void
  /** Standard slot kit hook; see {@link readSessions} for the fallback. */
  useSessions?: SessionsHook
}): ReactElement {
  ensureStyle()
  const [state, setState] = useState<VideoList | null>(null)
  const [fit, setFit] = useState<Fit>(() => readFit())
  const [sound, setSound] = useState<Sound>(() => readSound())
  const [msg, setMsg] = useState<{ text: string; kind: string }>({ text: '', kind: '' })
  const [busy, setBusy] = useState(false)
  const pinned = usePinned()
  const sessions = readSessions(useSessions, EMPTY_SESSIONS)
  const pinnedRows: PinnedRow[] = pinned.map((id) => ({ id, title: sessionTitle(sessions, id) }))

  const load = useCallback(async () => {
    try {
      const response = await fetch(LIST_URL, { cache: 'no-store' })
      const data = (await response.json()) as VideoList
      setState(data)
      setMsg({ text: '', kind: '' })
    } catch (error: unknown) {
      setMsg({ text: '读取片库失败：' + String(error), kind: 'dba-err' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Esc closes, like any other dialog in the shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = useCallback(
    async (id: string) => {
      setBusy(true)
      try {
        const response = await fetch(SELECT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const data = (await response.json()) as { ok?: boolean; error?: string; name?: string }
        if (data.ok === true) {
          setMsg({ text: '已切换：' + String(data.name ?? id) + '（下次播片头生效）', kind: 'dba-ok' })
          await load()
        } else {
          setMsg({ text: '切换失败：' + String(data.error ?? '未知错误'), kind: 'dba-err' })
        }
      } catch (error: unknown) {
        setMsg({ text: '切换失败：' + String(error), kind: 'dba-err' })
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const videos = state === null ? [] : state.videos
  const activeId = state === null ? null : state.activeId

  return h(
    'div',
    {
      className: 'dba-veil',
      onClick: (event: { target: unknown; currentTarget: unknown; stopPropagation: () => void }) => {
        if (event.target === event.currentTarget) onClose()
      },
    },
    h(
      'div',
      { className: 'dba-lib', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('h3', null, '片头片库'),
      h(
        'p',
        null,
        '选中的那段会在下次播放片头时登场 —— 新对话、以及你钉住的会话。',
      ),
      ...(videos.length === 0
        ? [h('div', { className: 'dba-item' }, h('span', { className: 'dba-nm' }, '（还没找到任何视频）'))]
        : videos.map((v) =>
            h(
              'div',
              {
                key: v.id,
                className: 'dba-item' + (v.id === activeId ? ' dba-cur' : ''),
                title: v.file,
                onClick: () => {
                  if (!busy && v.id !== activeId) void choose(v.id)
                },
              },
              h('span', { className: 'dba-mark' }, v.id === activeId ? '✓' : ''),
              h('span', { className: 'dba-nm' }, v.name),
              v.legacy ? h('span', { className: 'dba-badge' }, '原片源') : null,
              (v.copies ?? 1) > 1
                ? h(
                    'span',
                    {
                      className: 'dba-badge',
                      title:
                        '这一段在磁盘上有 ' +
                        String(v.copies) +
                        ' 份相同的副本，已合并成一条。你的文件没有被删，只是不重复列出。',
                    },
                    '合并 ' + String(v.copies) + ' 份重复',
                  )
                : null,
              // Only nudges on containers that can carry moov. A .webm has none,
              // so "not optimised" would be a lie about it.
              (v.ext === '.mp4' || v.ext === '.m4v') && v.faststart === false
                ? h(
                    'span',
                    {
                      className: 'dba-badge dba-b-warn',
                      title: '这个文件的索引表(moov)在末尾：浏览器要整段下载完才出画面，容易黑屏。用 ffmpeg -c copy -movflags +faststart 重排一次即可。',
                    },
                    '⚠ 未优化',
                  )
                : null,
              h('span', { className: 'dba-badge' }, SOURCE_LABEL[v.source] ?? v.source),
              h('span', { className: 'dba-meta' }, formatBytes(v.bytes)),
            ),
          )),
      // The pinned-conversation list. It exists so a pin can be undone without
      // having to find and open that conversation first — which is the whole
      // cost of allowing an unlimited number of them.
      h(
        'div',
        { className: 'dba-sec' },
        '片头会话（每次打开都播）',
        h(
          'span',
          { className: 'dba-sec-n' },
          pinnedRows.length === 0 ? '：还没有' : '：已钉住 ' + String(pinnedRows.length) + ' 个',
        ),
      ),
      pinnedRows.length === 0
        ? h(
            'div',
            { className: 'dba-empty' },
            '打开一个会话，点侧边栏页脚的 🎞 就能把它钉成片头会话。可以钉任意多个，每次打开它们都会播放片头动画。',
          )
        : h(
            'div',
            null,
            ...pinnedRows.map((row) =>
              h(
                'div',
                { key: row.id, className: 'dba-item dba-pinrow', title: row.id },
                h('span', { className: 'dba-mark' }, '🎬'),
                // The title comes from the session roster; a conversation whose
                // title is not known yet (a brand new one, or a roster entry
                // that has not loaded) falls back to its id rather than to a
                // guess. The full id stays in the row's tooltip either way.
                h(
                  'span',
                  { className: 'dba-nm' },
                  row.title ?? '会话 ' + row.id.slice(0, 8) + '…',
                ),
                row.title === undefined ? h('span', { className: 'dba-badge' }, '标题未知') : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dba-unpin',
                    title: '取消钉住这个会话',
                    onClick: () => {
                      const next = pinnedRows.filter((other) => other.id !== row.id).map((other) => other.id)
                      writePinned(next)
                      setMsg({
                        text: '已取消钉住：' + (row.title ?? row.id.slice(0, 8) + '…'),
                        kind: 'dba-ok',
                      })
                    },
                  },
                  '移除',
                ),
              ),
            ),
            pinnedRows.length > 1
              ? h(
                  'div',
                  { className: 'dba-bar' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dba-btn',
                      title: '取消全部片头会话（视频选择、贴合方式、声音都不受影响）',
                      onClick: () => {
                        writePinned([])
                        setMsg({ text: '已取消全部片头会话', kind: 'dba-ok' })
                      },
                    },
                    '全部取消',
                  ),
                )
              : null,
          ),
      h(
        'div',
        { className: 'dba-dir' },
        '想加自己的片子：把 mp4 放进这个文件夹，再点「刷新」',
        h('br', null),
        h('code', null, state === null ? '…' : state.userDir),
      ),
      h(
        'div',
        { className: 'dba-fit' },
        h('span', null, '播放时：'),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (fit === 'cover' ? ' dba-btn-on' : ''),
            title: '铺满整个窗口，超出部分裁掉 —— 不留黑边',
            onClick: () => {
              writeFit('cover')
              setFit('cover')
              setMsg({ text: '已设为「铺满屏幕」：下次播放生效', kind: 'dba-ok' })
            },
          },
          '铺满屏幕',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (fit === 'contain' ? ' dba-btn-on' : ''),
            title: '完整显示整帧，长宽比不匹配时留黑边',
            onClick: () => {
              writeFit('contain')
              setFit('contain')
              setMsg({ text: '已设为「完整显示」：下次播放生效', kind: 'dba-ok' })
            },
          },
          '完整显示',
        ),
      ),
      h(
        'div',
        { className: 'dba-fit' },
        h('span', null, '声音：'),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (sound === 'on' ? ' dba-btn-on' : ''),
            title: '有声音播放（默认）。浏览器若拦截带声音的自动播放，这一段会自动静音播放',
            onClick: () => {
              writeSound('on')
              setSound('on')
              setMsg({ text: '已打开声音：下次播放生效', kind: 'dba-ok' })
            },
          },
          '打开',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (sound === 'off' ? ' dba-btn-on' : ''),
            title: '静音播放',
            onClick: () => {
              writeSound('off')
              setSound('off')
              setMsg({ text: '已关闭声音：下次播放生效', kind: 'dba-ok' })
            },
          },
          '关闭',
        ),
      ),
      h(
        'div',
        { className: 'dba-bar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn dba-btn-preview',
            title: '立刻播放当前选中的这段，不用等下一次开新对话或钉住的会话',
            onClick: onPreview,
          },
          '▶ 预览当前',
        ),
        h(
          'button',
          { type: 'button', className: 'dba-btn', onClick: () => void load() },
          '刷新',
        ),
        h('button', { type: 'button', className: 'dba-btn dba-close', onClick: onClose }, '关闭'),
      ),
      h('div', { className: 'dba-msg ' + msg.kind }, msg.text),
    ),
  )
}

type ClientContext = {
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  uiSession?: { adapter?: { current?: CurrentStore } }
  effect?: (callback: () => unknown, label?: string) => unknown
}

/**
 * Opens the library from outside the overlay's own React tree.
 *
 * The pin sits in a different slot than the overlay, so it cannot share React
 * state with the component that renders the dialog: they are two separate roots
 * that this plugin happens to register. A module-level listener pair is the
 * smallest honest bridge between them.
 */
const libraryOpeners = new Set<() => void>()
function openLibrary(): void {
  for (const open of libraryOpeners) {
    try {
      open()
    } catch {
      /* a stale subscriber must not break the pin */
    }
  }
}

export function apply(ctx: ClientContext): void {
  const candidate = ctx.uiSession?.adapter?.current
  const store =
    candidate !== undefined &&
    typeof candidate.getSnapshot === 'function' &&
    typeof candidate.subscribe === 'function'
      ? candidate
      : null
  log('apply', { hasUiSession: ctx.uiSession !== undefined, hasStore: store !== null })

  // Warm the media cache before any overlay can open, so the first play starts
  // from the local copy instead of the network. Deliberately here, not at the
  // trigger: the version has to be known before a src is built.
  resolveActiveVersion()

  // Rendering a JSX-free tree on purpose (createElement), so no provider
  // element is involved. Hooks live in AppRoot, never in apply: apply is called
  // by the plugin loader, not by React, and a hook call there would throw.
  //
  // AppRoot takes the slot kit's props because the management list needs the
  // conversation roster (`useSessions`). It is forwarded explicitly: a component
  // rendered as a child element does not inherit the renderer's kit, only the
  // slot entry itself receives it.
  const AppRoot = (kit: { useSessions?: SessionsHook }) => {
    const [libOpen, setLibOpen] = useState(false)
    // Bumped on preview. Closing the library and bumping in the same handler is
    // what makes it work: BootOverlay only exists while the library is closed.
    const [previewAt, setPreviewAt] = useState(0)

    const openSelf = useCallback(() => setLibOpen(true), [])
    useEffect(() => {
      libraryOpeners.add(openSelf)
      return () => {
        libraryOpeners.delete(openSelf)
      }
    }, [openSelf])

    // Rendered as ELEMENTS, never called as plain functions. Calling a
    // component directly would run its hooks against AppRoot's own hook list,
    // so toggling the library would change AppRoot's hook count between renders
    // and React would throw "Rendered more hooks than during the previous
    // render" the moment the picker opened.
    //
    // No `activeId` state lives here: the overlay always loads VIDEO_URL and the
    // host resolves which clip that is per request, so a switch is picked up on
    // the next open without threading an id into the src mid-playback.
    if (libOpen) {
      return h(VideoLibrary, {
        onClose: () => setLibOpen(false),
        onPreview: () => {
          setLibOpen(false)
          setPreviewAt((n) => n + 1)
        },
        useSessions: kit?.useSessions,
      })
    }
    return h(BootOverlay, { store, previewAt })
  }

  const Pin = () => h(PinAction, { store, onOpen: () => openLibrary() })

  // Slot names are inlined on purpose: the injector's pre-flight check reads
  // register() calls statically and cannot follow a constant.
  const mount = () => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'dsh-boot-animation', order: 900 }, AppRoot),
    )
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-boot-animation-pin', order: 40, label: () => '片头动画' },
        Pin,
      ),
    )
  }
  if (typeof ctx.effect === 'function') ctx.effect(mount, 'dsh-boot-animation: mounts')
  else mount()
}

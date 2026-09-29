window.__ModuleLoader__.load({
	id: "dsh-boot-animation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		/** Slot service for both seats, ui-session for the current conversation. */
		const inject = ["slots", "uiSession"];
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
		const VIDEO_URL = "/dsh-boot-animation/boot.mp4";
		const LIST_URL = "/dsh-boot-animation/videos.json";
		const SELECT_URL = "/dsh-boot-animation/select";
		const SEEN_KEY = "dsh-boot-animation:seen";
		/** JSON array of pinned session ids. A bare id here is the single-pin legacy shape. */
		const PIN_KEY = "dsh-boot-animation:pinned";
		const FIT_KEY = "dsh-boot-animation:fit";
		const SOUND_KEY = "dsh-boot-animation:sound";
		const MAX_SEEN = 80;
		/** Never let a stalled video trap the user behind the overlay. */
		const STALL_TIMEOUT_MS = 25e3;
		/**
		* How long after the overlay opens a click is ignored.
		*
		* The click that opened the conversation is the reason the overlay exists, and a
		* DOUBLE click on a sidebar row delivers its second click a couple of hundred
		* milliseconds later — onto an overlay that now covers the window, which would
		* skip the animation the user just asked for before a single frame showed.
		*/
		const SKIP_GRACE_MS = 400;
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
		let activeVersion = null;
		let versionStarted = false;
		function resolveActiveVersion() {
			if (versionStarted) return;
			versionStarted = true;
			(async () => {
				try {
					const response = await fetch(LIST_URL, { cache: "no-store" });
					if (!response.ok) return;
					const version = (await response.json()).activeVersion;
					if (typeof version !== "string" || version === "") return;
					activeVersion = version;
					await fetch(videoSrc(), { cache: "force-cache" });
					notify("media prefetched", videoSrc());
				} catch (error) {
					notify("prefetch failed", String(error));
				}
			})();
		}
		/** The URL to play, carrying the content key when it is already known. */
		function videoSrc() {
			return activeVersion === null ? VIDEO_URL : VIDEO_URL + "?v=" + encodeURIComponent(activeVersion);
		}
		function readFit() {
			try {
				return window.localStorage.getItem(FIT_KEY) === "contain" ? "contain" : "cover";
			} catch {
				return "cover";
			}
		}
		function writeFit(fit) {
			try {
				window.localStorage.setItem(FIT_KEY, fit);
			} catch {}
		}
		function readSound() {
			try {
				return window.localStorage.getItem(SOUND_KEY) === "off" ? "off" : "on";
			} catch {
				return "on";
			}
		}
		function writeSound(sound) {
			try {
				window.localStorage.setItem(SOUND_KEY, sound);
			} catch {}
		}
		function formatArgs(args) {
			return args.map((a) => {
				if (typeof a === "object" && a !== null) try {
					return JSON.stringify(a);
				} catch {
					return String(a);
				}
				return String(a);
			}).join(" ");
		}
		function narrate(text) {
			try {
				console.log("[dsh-boot-animation] " + text);
			} catch {}
		}
		/**
		* The always-on subset. A black overlay reports nothing by itself — no network
		* error, no thrown exception, just a video element that never paints — so the
		* four things needed to diagnose one from the outside are logged unconditionally:
		* which URL the element actually used, when the first frame arrived, when the
		* element errored and with which code, and when the stall watchdog gave up.
		* They are one line each and only fire on a play, so the noise is bounded.
		*/
		function notify(...args) {
			narrate(formatArgs(args));
		}
		function readSeen() {
			try {
				const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
			} catch {
				return [];
			}
		}
		function hasPlayed(sessionId) {
			return readSeen().includes(sessionId);
		}
		function markPlayed(sessionId) {
			try {
				const seen = readSeen();
				if (!seen.includes(sessionId)) seen.push(sessionId);
				while (seen.length > MAX_SEEN) seen.shift();
				window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
			} catch {}
		}
		function readPinned() {
			try {
				const raw = window.localStorage.getItem(PIN_KEY);
				if (raw === null || raw === "") return [];
				if (!raw.startsWith("[")) return [raw];
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				const ids = parsed.filter((value) => typeof value === "string" && value !== "");
				return [...new Set(ids)];
			} catch {
				return [];
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
		const pinListeners = /* @__PURE__ */ new Set();
		function writePinned(ids) {
			try {
				if (ids.length === 0) window.localStorage.removeItem(PIN_KEY);
				else window.localStorage.setItem(PIN_KEY, JSON.stringify(ids));
			} catch {}
			for (const listener of [...pinListeners]) try {
				listener();
			} catch {}
		}
		/** The live pin list, re-read on every change from either root. */
		function usePinned() {
			const [pinned, setPinned] = (0, react.useState)(() => readPinned());
			(0, react.useEffect)(() => {
				const refresh = () => setPinned(readPinned());
				pinListeners.add(refresh);
				refresh();
				const onStorage = (event) => {
					if (event.key === null || event.key === PIN_KEY) refresh();
				};
				window.addEventListener("storage", onStorage);
				return () => {
					pinListeners.delete(refresh);
					window.removeEventListener("storage", onStorage);
				};
			}, []);
			return pinned;
		}
		/** Add the conversation when it is not pinned, drop it when it is. */
		function togglePin(pinned, sessionId) {
			return pinned.includes(sessionId) ? pinned.filter((id) => id !== sessionId) : [...pinned, sessionId];
		}
		const STYLE_ID = "dsh-boot-animation-style";
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
`;
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		const noopSubscribe = () => () => {};
		/** Subscribe to the current-conversation store, tolerating its absence. */
		function useCurrentSession(store) {
			const binding = (0, react.useSyncExternalStore)(store === null ? noopSubscribe : store.subscribe, store === null ? () => null : store.getSnapshot);
			return {
				sessionId: typeof binding?.props?.sessionId === "string" ? binding.props.sessionId : null,
				isNewConversation: binding?.hooks?.session?.blankBit === true
			};
		}
		function BootOverlay({ store, previewAt = 0 }) {
			ensureStyle();
			const { sessionId, isNewConversation } = useCurrentSession(store);
			const fit = readFit();
			const [showing, setShowing] = (0, react.useState)(false);
			/**
			* True only when the browser refused to start the clip at all — audible AND
			* muted. It no longer offers a click-to-play recovery, because a click is the
			* skip gesture now; it just swaps the hint for an explanation.
			*/
			const [blocked, setBlocked] = (0, react.useState)(false);
			const [phase, setPhase] = (0, react.useState)("loading");
			/**
			* Frozen at mount, deliberately: `videoSrc()` reads a value that resolves from
			* an async fetch, and letting the src change after mount is exactly the black
			* frame bug this plugin already paid for once (see the note above VIDEO_URL).
			*/
			const [src] = (0, react.useState)(videoSrc);
			const videoRef = (0, react.useRef)(null);
			const closedRef = (0, react.useRef)(false);
			const lastSessionRef = (0, react.useRef)(null);
			/** When the current play started, so an opening double-click cannot skip it. */
			const openedAtRef = (0, react.useRef)(0);
			const close = (0, react.useCallback)(() => {
				closedRef.current = true;
				setShowing(false);
				const video = videoRef.current;
				if (video !== null) try {
					video.pause();
				} catch {}
				if (document.fullscreenElement !== null && document.exitFullscreen !== void 0) document.exitFullscreen().catch(() => {});
			}, []);
			const open = (0, react.useCallback)(() => {
				closedRef.current = false;
				setBlocked(false);
				openedAtRef.current = performance.now();
				setShowing(true);
			}, []);
			/**
			* The whole skip gesture: a click anywhere on the overlay, video included.
			*
			* The video used to stop propagation so that a click on the picture reached
			* the unmute/fullscreen handler; with one click meaning "skip", a click that
			* landed on the video would be the one click that did nothing, so that guard
			* is gone and every click bubbles here.
			*/
			const skip = (0, react.useCallback)(() => {
				if (performance.now() - openedAtRef.current < SKIP_GRACE_MS) return;
				close();
			}, [close]);
			(0, react.useEffect)(() => {
				if (sessionId === null) return;
				const entered = lastSessionRef.current !== sessionId;
				lastSessionRef.current = sessionId;
				if (!entered) return;
				if (readPinned().includes(sessionId)) {
					open();
					return;
				}
				if (isNewConversation && !hasPlayed(sessionId)) {
					markPlayed(sessionId);
					open();
				}
			}, [
				sessionId,
				isNewConversation,
				open
			]);
			(0, react.useEffect)(() => {
				if (previewAt === 0) return;
				open();
			}, [previewAt, open]);
			(0, react.useEffect)(() => {
				if (!showing) return void 0;
				const video = videoRef.current;
				if (video === null) return void 0;
				const wantedSound = readSound() === "on";
				const openedAt = performance.now();
				/** One line that carries everything a black-frame report needs. */
				const report = (label) => notify(label, {
					ms: Math.round(performance.now() - openedAt),
					readyState: video.readyState,
					networkState: video.networkState,
					src: video.currentSrc || video.src
				});
				const onPlaying = () => {
					setPhase("playing");
					report("first frame painted");
				};
				video.addEventListener("playing", onPlaying);
				const start = (muted) => {
					video.muted = muted;
					const attempt = video.play();
					return attempt !== void 0 && typeof attempt.then === "function" ? attempt : Promise.resolve();
				};
				start(!wantedSound).then(() => void 0, (error) => {
					if (!wantedSound) {
						setBlocked(true);
						return;
					}
					notify("audible autoplay refused, retrying muted", String(error));
					start(true).then(() => void 0, (second) => {
						setBlocked(true);
					});
				});
				const guard = window.setTimeout(() => {
					if (!closedRef.current) {
						setPhase("stalled");
						report("stalled, giving up after 25000ms");
						close();
					}
				}, STALL_TIMEOUT_MS);
				return () => {
					video.removeEventListener("playing", onPlaying);
					window.clearTimeout(guard);
				};
			}, [showing, close]);
			if (!showing) return null;
			return (0, react.createElement)("div", {
				className: "dba-root",
				onClick: skip
			}, (0, react.createElement)("video", {
				ref: videoRef,
				className: fit === "cover" ? "dba-video dba-cover" : "dba-video",
				src,
				muted: readSound() === "off",
				playsInline: true,
				preload: "auto",
				onEnded: close,
				onError: () => {
					const video = videoRef.current;
					notify("video element error", {
						code: video?.error?.code ?? 0,
						message: video?.error?.message ?? "",
						src: video?.currentSrc || src,
						readyState: video?.readyState ?? -1
					});
					setPhase("error");
					window.setTimeout(() => {
						if (!closedRef.current) close();
					}, 8e3);
				}
			}), phase === "playing" ? null : (0, react.createElement)("div", { className: "dba-status" }, phase === "error" ? "视频加载失败 —— 控制台有 [dsh-boot-animation] 日志" : phase === "stalled" ? "视频加载超时" : "正在加载视频…"), (0, react.createElement)("div", { className: "dba-hint" }, blocked ? "浏览器拦截了自动播放 —— 点击任意位置关闭" : "点击任意位置跳过"));
		}
		/** The pin toggle that lives beside Settings at the sidebar foot. */
		/** The pin toggle that lives beside Settings at the sidebar foot. */
		function PinAction({ store, onOpen }) {
			ensureStyle();
			const { sessionId } = useCurrentSession(store);
			const pinned = usePinned();
			const isPinned = sessionId !== null && pinned.includes(sessionId);
			const toggle = () => {
				if (sessionId === null) return;
				writePinned(togglePin(pinned, sessionId));
			};
			const title = isPinned ? "这个会话已设为片头会话：每次打开都会播放片头动画（点击取消）" : "把这个会话设为片头会话：以后每次打开它都会播放片头动画";
			const count = pinned.length;
			const label = count === 0 ? title : title + "（已钉住 " + String(count) + " 个会话）";
			return (0, react.createElement)("span", {
				className: "dba-pin-wrap",
				style: {
					display: "inline-flex",
					alignItems: "center"
				}
			}, (0, react.createElement)("button", {
				type: "button",
				className: isPinned ? "dba-pin dba-pin-on" : "dba-pin",
				title: label,
				"aria-label": label,
				disabled: sessionId === null,
				onClick: toggle
			}, isPinned ? "🎬" : "🎞", count === 0 ? null : (0, react.createElement)("span", { className: "dba-pin-count" }, String(count))), (0, react.createElement)("button", {
				type: "button",
				className: "dba-pin dba-lib-open",
				title: "片头片库：查看、切换或添加片头视频，管理已钉住的会话",
				"aria-label": "打开片头片库",
				onClick: onOpen
			}, "🎛"));
		}
		function formatBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
			return (n / 1024 / 1024).toFixed(2) + " MB";
		}
		/**
		* Where a clip comes from, as one word a user can act on.
		*
		* The plugin's clips are embedded in code now, so there is a single built-in
		* kind; anything else on the list is a file the user put there.
		*/
		const SOURCE_LABEL = {
			yours: "你自己加的",
			embedded: "插件内置",
			env: "环境变量"
		};
		/** Stable empty roster, returned when the hook prop is missing. */
		const EMPTY_SESSIONS = {
			phase: "ready",
			byId: {}
		};
		/**
		* The selector handed to `useSessions`.
		*
		* Module-level so its identity never changes: `useSyncExternalStoreWithSelector`
		* memoizes per selector, and a fresh arrow on every render would throw that
		* memoization away. Selecting the whole snapshot is deliberate — the selector
		* may only read the store, never component state, so the pinned-row mapping
		* happens in the component where it can see `pinned`.
		*/
		const WHOLE_ROSTER = (state) => state;
		/**
		* Read the roster defensively.
		*
		* `useSessions` is part of the standard kit the renderer synthesizes for every
		* slot entry, so it is present in practice — but a slot rendered outside the
		* root-source provider would hand us `undefined`, and a panel that throws is
		* worse than a panel showing raw ids. The substitution happens at the call site
		* and is stable for the life of the component: the prop cannot appear later.
		*/
		function readSessions(hook, fallback) {
			if (hook === void 0) return fallback;
			return hook(WHOLE_ROSTER);
		}
		function sessionTitle(state, sessionId) {
			const title = state.byId?.[sessionId]?.title;
			return typeof title === "string" && title !== "" ? title : void 0;
		}
		/**
		* The video library: every .mp4 the host can see, the active one marked, and a
		* click to switch. Adding a video stays a filesystem action — the user drops a
		* file in and presses refresh — because a browser-side upload would have to
		* carry the bytes through this route for no gain on a local-only plugin.
		*
		* It also carries the pinned-conversation management list: the only place a pin
		* can be dropped without first opening the conversation it belongs to.
		*/
		function VideoLibrary({ onClose, onPreview, useSessions }) {
			ensureStyle();
			const [state, setState] = (0, react.useState)(null);
			const [fit, setFit] = (0, react.useState)(() => readFit());
			const [sound, setSound] = (0, react.useState)(() => readSound());
			const [msg, setMsg] = (0, react.useState)({
				text: "",
				kind: ""
			});
			const [busy, setBusy] = (0, react.useState)(false);
			const pinned = usePinned();
			const sessions = readSessions(useSessions, EMPTY_SESSIONS);
			const pinnedRows = pinned.map((id) => ({
				id,
				title: sessionTitle(sessions, id)
			}));
			const load = (0, react.useCallback)(async () => {
				try {
					const data = await (await fetch(LIST_URL, { cache: "no-store" })).json();
					setState(data);
					setMsg({
						text: "",
						kind: ""
					});
				} catch (error) {
					setMsg({
						text: "读取片库失败：" + String(error),
						kind: "dba-err"
					});
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			const choose = (0, react.useCallback)(async (id) => {
				setBusy(true);
				try {
					const data = await (await fetch(SELECT_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					})).json();
					if (data.ok === true) {
						setMsg({
							text: "已切换：" + String(data.name ?? id) + "（下次播片头生效）",
							kind: "dba-ok"
						});
						await load();
					} else setMsg({
						text: "切换失败：" + String(data.error ?? "未知错误"),
						kind: "dba-err"
					});
				} catch (error) {
					setMsg({
						text: "切换失败：" + String(error),
						kind: "dba-err"
					});
				} finally {
					setBusy(false);
				}
			}, [load]);
			const videos = state === null ? [] : state.videos;
			const activeId = state === null ? null : state.activeId;
			return (0, react.createElement)("div", {
				className: "dba-veil",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				}
			}, (0, react.createElement)("div", {
				className: "dba-lib",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("h3", null, "片头片库"), (0, react.createElement)("p", null, "选中的那段会在下次播放片头时登场 —— 新对话、以及你钉住的会话。"), ...videos.length === 0 ? [(0, react.createElement)("div", { className: "dba-item" }, (0, react.createElement)("span", { className: "dba-nm" }, "（还没找到任何视频）"))] : videos.map((v) => (0, react.createElement)("div", {
				key: v.id,
				className: "dba-item" + (v.id === activeId ? " dba-cur" : ""),
				title: v.file,
				onClick: () => {
					if (!busy && v.id !== activeId) choose(v.id);
				}
			}, (0, react.createElement)("span", { className: "dba-mark" }, v.id === activeId ? "✓" : ""), (0, react.createElement)("span", { className: "dba-nm" }, v.name), v.legacy ? (0, react.createElement)("span", { className: "dba-badge" }, "原片源") : null, (v.copies ?? 1) > 1 ? (0, react.createElement)("span", {
				className: "dba-badge",
				title: "这一段在磁盘上有 " + String(v.copies) + " 份相同的副本，已合并成一条。你的文件没有被删，只是不重复列出。"
			}, "合并 " + String(v.copies) + " 份重复") : null, (v.ext === ".mp4" || v.ext === ".m4v") && v.faststart === false ? (0, react.createElement)("span", {
				className: "dba-badge dba-b-warn",
				title: "这个文件的索引表(moov)在末尾：浏览器要整段下载完才出画面，容易黑屏。用 ffmpeg -c copy -movflags +faststart 重排一次即可。"
			}, "⚠ 未优化") : null, (0, react.createElement)("span", { className: "dba-badge" }, SOURCE_LABEL[v.source] ?? v.source), (0, react.createElement)("span", { className: "dba-meta" }, formatBytes(v.bytes)))), (0, react.createElement)("div", { className: "dba-sec" }, "片头会话（每次打开都播）", (0, react.createElement)("span", { className: "dba-sec-n" }, pinnedRows.length === 0 ? "：还没有" : "：已钉住 " + String(pinnedRows.length) + " 个")), pinnedRows.length === 0 ? (0, react.createElement)("div", { className: "dba-empty" }, "打开一个会话，点侧边栏页脚的 🎞 就能把它钉成片头会话。可以钉任意多个，每次打开它们都会播放片头动画。") : (0, react.createElement)("div", null, ...pinnedRows.map((row) => (0, react.createElement)("div", {
				key: row.id,
				className: "dba-item dba-pinrow",
				title: row.id
			}, (0, react.createElement)("span", { className: "dba-mark" }, "🎬"), (0, react.createElement)("span", { className: "dba-nm" }, row.title ?? "会话 " + row.id.slice(0, 8) + "…"), row.title === void 0 ? (0, react.createElement)("span", { className: "dba-badge" }, "标题未知") : null, (0, react.createElement)("button", {
				type: "button",
				className: "dba-unpin",
				title: "取消钉住这个会话",
				onClick: () => {
					writePinned(pinnedRows.filter((other) => other.id !== row.id).map((other) => other.id));
					setMsg({
						text: "已取消钉住：" + (row.title ?? row.id.slice(0, 8) + "…"),
						kind: "dba-ok"
					});
				}
			}, "移除"))), pinnedRows.length > 1 ? (0, react.createElement)("div", { className: "dba-bar" }, (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn",
				title: "取消全部片头会话（视频选择、贴合方式、声音都不受影响）",
				onClick: () => {
					writePinned([]);
					setMsg({
						text: "已取消全部片头会话",
						kind: "dba-ok"
					});
				}
			}, "全部取消")) : null), (0, react.createElement)("div", { className: "dba-dir" }, "想加自己的片子：把 mp4 放进这个文件夹，再点「刷新」", (0, react.createElement)("br", null), (0, react.createElement)("code", null, state === null ? "…" : state.userDir)), (0, react.createElement)("div", { className: "dba-fit" }, (0, react.createElement)("span", null, "播放时："), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn" + (fit === "cover" ? " dba-btn-on" : ""),
				title: "铺满整个窗口，超出部分裁掉 —— 不留黑边",
				onClick: () => {
					writeFit("cover");
					setFit("cover");
					setMsg({
						text: "已设为「铺满屏幕」：下次播放生效",
						kind: "dba-ok"
					});
				}
			}, "铺满屏幕"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn" + (fit === "contain" ? " dba-btn-on" : ""),
				title: "完整显示整帧，长宽比不匹配时留黑边",
				onClick: () => {
					writeFit("contain");
					setFit("contain");
					setMsg({
						text: "已设为「完整显示」：下次播放生效",
						kind: "dba-ok"
					});
				}
			}, "完整显示")), (0, react.createElement)("div", { className: "dba-fit" }, (0, react.createElement)("span", null, "声音："), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn" + (sound === "on" ? " dba-btn-on" : ""),
				title: "有声音播放（默认）。浏览器若拦截带声音的自动播放，这一段会自动静音播放",
				onClick: () => {
					writeSound("on");
					setSound("on");
					setMsg({
						text: "已打开声音：下次播放生效",
						kind: "dba-ok"
					});
				}
			}, "打开"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn" + (sound === "off" ? " dba-btn-on" : ""),
				title: "静音播放",
				onClick: () => {
					writeSound("off");
					setSound("off");
					setMsg({
						text: "已关闭声音：下次播放生效",
						kind: "dba-ok"
					});
				}
			}, "关闭")), (0, react.createElement)("div", { className: "dba-bar" }, (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-btn-preview",
				title: "立刻播放当前选中的这段，不用等下一次开新对话或钉住的会话",
				onClick: onPreview
			}, "▶ 预览当前"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn",
				onClick: () => void load()
			}, "刷新"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-close",
				onClick: onClose
			}, "关闭")), (0, react.createElement)("div", { className: "dba-msg " + msg.kind }, msg.text)));
		}
		/**
		* Opens the library from outside the overlay's own React tree.
		*
		* The pin sits in a different slot than the overlay, so it cannot share React
		* state with the component that renders the dialog: they are two separate roots
		* that this plugin happens to register. A module-level listener pair is the
		* smallest honest bridge between them.
		*/
		const libraryOpeners = /* @__PURE__ */ new Set();
		function openLibrary() {
			for (const open of libraryOpeners) try {
				open();
			} catch {}
		}
		function apply(ctx) {
			const candidate = ctx.uiSession?.adapter?.current;
			const store = candidate !== void 0 && typeof candidate.getSnapshot === "function" && typeof candidate.subscribe === "function" ? candidate : null;
			ctx.uiSession;
			resolveActiveVersion();
			const AppRoot = (kit) => {
				const [libOpen, setLibOpen] = (0, react.useState)(false);
				const [previewAt, setPreviewAt] = (0, react.useState)(0);
				const openSelf = (0, react.useCallback)(() => setLibOpen(true), []);
				(0, react.useEffect)(() => {
					libraryOpeners.add(openSelf);
					return () => {
						libraryOpeners.delete(openSelf);
					};
				}, [openSelf]);
				if (libOpen) return (0, react.createElement)(VideoLibrary, {
					onClose: () => setLibOpen(false),
					onPreview: () => {
						setLibOpen(false);
						setPreviewAt((n) => n + 1);
					},
					useSessions: kit?.useSessions
				});
				return (0, react.createElement)(BootOverlay, {
					store,
					previewAt
				});
			};
			const Pin = () => (0, react.createElement)(PinAction, {
				store,
				onOpen: () => openLibrary()
			});
			const mount = () => {
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-boot-animation",
					order: 900
				}, AppRoot));
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
					name: "sidebar.footer.action",
					id: "dsh-boot-animation-pin",
					order: 40,
					label: () => "片头动画"
				}, Pin));
			};
			if (typeof ctx.effect === "function") ctx.effect(mount, "dsh-boot-animation: mounts");
			else mount();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
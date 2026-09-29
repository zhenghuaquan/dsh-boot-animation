# dsh-boot-animation

A **boot animation** for DSH: when you open a new conversation — or a conversation
you pinned — a video plays full-frame in the app window.

> 中文: [README.md](README.md)

- Plays **once per new conversation** by default
- **Or every time** you open a conversation you pinned — as many pins as you like,
  one click each (in the sidebar footer)
- Plays **with sound by default** (turn it off in the library panel)
- Fills the whole window, **click anywhere to skip**, closes itself when it ends
- **Bring your own video** (three ways, below)

## Install

```sh
dsh plugin --profile web add github:NativeDog1/dsh-boot-animation
```

> The built output (`lib/`) is committed and the package has no `prepare`
> lifecycle script, so this installs **without compiling anything** and without
> tripping pnpm's `allowBuilds` build-approval prompt.
> (Once the package is on npm, `dsh plugin --profile web add dsh-boot-animation` works too.)

Then **restart the DSH service once** — bundle layers are assembled at boot:

```sh
# stop the running `dsh web`, then
dsh web
```

### Nothing happens after installing? Do this first

DSH serves client bundles with `cache-control: max-age=31536000, immutable`, and
the `rev` in the URL is a **per-process nonce** that does not change with content.
Your browser therefore keeps the first copy it ever fetched.

Press **Ctrl+Shift+R** (hard reload) in the app window. A plain F5 is not enough.

## Usage

**New conversations** play it automatically, once each.

**Pin a conversation** to replay it on *every* open:

1. Open that conversation
2. Click the **🎞** icon at the sidebar foot (next to Settings)
3. It turns green **🎬** — pinned. The small green number on it is how many
   conversations are pinned in total

Every later entry into those conversations replays the animation, including after
switching away and back, or reloading.

**Pin as many as you like — there is no limit.** Just open another conversation
and click the pin again.

To unpin: click the pin again while in that conversation, or open the library
panel (**🎛**) and press **移除** in the 片头会话 section — you do not have to
navigate back to that conversation first. With more than one pin there is also a
**全部取消**. Each row shows the conversation title; a brand new conversation
whose title has not been generated yet shows `会话 <first 8 of the id>…`
(hover the row for the full id).

> If at startup your active main panel is not the conversation (e.g. some plugin's
> panel is showing), there is no current conversation yet and the pin is disabled.
> Open a conversation first.

## Built-in clips and your own video

The plugin is a **library**, not a single slot: it lists every clip it can find,
you pick one, and the choice is remembered.

**Four clips ship with it**, embedded in the code (`lib/clips.data.js`, base64 —
there are no mp4 files on disk for them):

| Name in the picker | Size |
|---|---|
| `DeepSeek 品牌片头` (brand) | 1.2 MB |
| `DeepSeek 赛博朋克片头` (cyberpunk) | 1.8 MB |
| `DeepSeek 数字角色苏醒` (awakening) | 2.5 MB |
| `DeepSeek 启动问题` (startup) | 3.2 MB |

All four are **faststart** remuxes (`moov` before `mdat`), so they play while
still downloading; the embed script refuses any input where it is not.
`media/*.mp4` is only the input to `npm run embed-clips` and is **not published**.

**Your own files still win.** The host re-resolves on every request, so swapping a
file needs no restart:

| Order | Location |
|---|---|
| 1 | the clip picked in the 🎛 library panel (`~/.dsh/boot-animation/selection.json`) |
| 2 | the file named by `DSH_BOOT_ANIMATION` |
| 3 | `~/.dsh/boot-animation/intro.mp4` |
| 4 | the newest file in `~/.dsh/boot-animation/videos/` |
| 5 | the four embedded clips above |

```sh
mkdir -p ~/.dsh/boot-animation/videos
cp my-intro.mp4 ~/.dsh/boot-animation/videos/
```

Then open the **🎛** button at the sidebar foot (next to the 🎞 pin) to pick it.

Check what is in use:

```sh
curl http://127.0.0.1:3080/dsh-boot-animation/status.json
```

## Browser policies you cannot avoid

Audible autoplay needs the user to have interacted with the page. Opening a
conversation **is** that interaction, so the overlay tries to play **with sound**
(the default). If the browser still refuses, it does not stop on the first frame:
the same `play()` is retried **muted**, so the animation runs silently instead,
and the hint says the browser blocked autoplay.

Skipping is **a click anywhere on the overlay**, video included — there is no
corner button. Clicks in the first **0.4 s** after it opens are ignored, so the
second click of the double-click that opened the conversation cannot skip the
clip before it starts.

> The overlay already covers the window, so it looks fullscreen; the old
> "click to enter real fullscreen" used the same click gesture that now means
> skip, so the Fullscreen API is no longer entered.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing appears at all | Almost always the cache: **Ctrl+Shift+R**, or restart DSH |
| New conversation does not play | That conversation already played it (once per conversation). Pin it to replay every time |
| Pinned but still nothing | Check the pin is green, and that you opened one of the pinned conversations (the number on the pin is the total, not "this one") |
| Pinned the wrong one | Unpin it the same way, or open the library panel and press 移除 in the 片头会话 list |
| A pinned row shows an id | That conversation has no generated title yet; hover the row for the full id, and the title replaces it once it exists |
| Black screen | Open `/dsh-boot-animation/status.json` to see whether a source was found; check the console for a decode error |
| No sound | Check the library panel's sound setting; if the browser blocked audible autoplay the plugin falls back to muted playback and logs a `[dsh-boot-animation]` line |
| It vanishes on one click | That is the skip gesture; a click within 0.4 s of opening is ignored on purpose |
| Want to see the decisions | Set `DEBUG = true` at the top of `src/client/index.ts`, rebuild, watch the console |

## Implementation notes

- Seats: `shell.overlay` (frame-wide floating layer, `kind: list`, additive) and
  `sidebar.footer.action` (the pin)
- The current conversation comes from `ctx.uiSession.adapter.current`, a
  React-friendly store whose snapshot is the **resolved descriptor output**
  `{ key, hooks, keyedHooks, props }` — the id is at `props.sessionId` and the
  session snapshot at `hooks.session`
- "Brand new conversation" is **`blankBit`** on that snapshot (`session.blank`
  lives on another package's projected summary, not here)
- "Every open" is implemented by watching **entry into** a conversation rather
  than remembering that it played, so a pinned conversation ignores the seen list
- **The pins are a list, not one id**: `dsh-boot-animation:pinned` holds a JSON
  array. The single-pin build stored a **bare id** under that key, and a bare id
  is not a JSON array — so the entire migration is reading it as a one-element
  list. No version field, no startup step, no pin lost on upgrade. The two React
  roots (sidebar pin / overlay dialog) stay in sync through the module-level
  `pinListeners` set, plus a `storage` listener for a second window on the same
  origin
- The management list's **conversation titles** come from the **`useSessions`**
  hook prop of the standard slot kit (the renderer hands root sources to every
  slot entry as `use<Name>`), with rows shaped `{ id, title }`. It is read
  **defensively**: no prop means falling back to the raw id, never throwing.
  Keep selectors dependent on the store snapshot only — the selector form of
  `useSyncExternalStore` reuses the previous selection while the snapshot is
  unchanged — so select `state`, then map `pinned` into rows in the component
- The video route honours **Range** requests; browsers send them for media and
  may refuse to play when a 200 arrives where a 206 was expected

## License

BSD-3-Clause, see [LICENSE](LICENSE). The bundled `assets/boot.mp4` ships under
the same terms.

/**
 * verify-pin.mjs - prove the pinned conversations replay the intro EVERY open.
 *
 * Disambiguation trick: the new-conversation rule is suppressed by marking the
 * session as already seen, so if the overlay still comes up after a fresh page
 * load into that conversation, only the PIN rule can be responsible.
 *
 * Also covers the multi-pin behaviour: TWO conversations are pinned (the old
 * build silently replaced the first), both must be listed in the library
 * dialog's management list, and 移除 must drop exactly one of them — the
 * surviving pin is the one the reload in step 4 must replay.
 *
 * Usage: node scripts/verify-pin.mjs <debugPort> <guiUrl>
 */

const port = Number(process.argv[2] ?? 9355)
const url = process.argv[3]
if (url === undefined) {
  console.error('usage: node scripts/verify-pin.mjs <debugPort> <guiUrl>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* starting */
    }
    await sleep(500)
  }
  throw new Error('no debuggable page target')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    const exceptions = []
    let nextId = 0
    socket.onopen = () =>
      resolve({
        exceptions,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = (nextId += 1)
            pending.set(id, { res, rej })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => socket.close(),
      })
    socket.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)))
    socket.onmessage = (event) => {
      let m
      try {
        m = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const entry = pending.get(m.id)
        pending.delete(m.id)
        if (m.error !== undefined) entry.rej(new Error(JSON.stringify(m.error)))
        else entry.res(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails ?? {}
        exceptions.push(String(d.exception?.description ?? d.text ?? 'unknown'))
      }
    }
  })
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails !== undefined) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}

async function waitTrue(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return true
    } catch {
      /* navigating */
    }
    await sleep(600)
  }
  return false
}

const SEEN = `window.localStorage.getItem('dsh-boot-animation:seen')`
/**
 * The pin list, as the plugin reads it: a JSON array, with the legacy bare-id
 * shape of the single-pin version read as a one-element list.
 */
const PINS = `(() => {
  const raw = window.localStorage.getItem('dsh-boot-animation:pinned');
  if (!raw) return [];
  if (!raw.startsWith('[')) return [raw];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
})()`

const page = await waitForPage()
const client = await connect(page.webSocketDebuggerUrl)
await client.send('Runtime.enable')
await client.send('Page.enable')

async function load() {
  await client.send('Page.navigate', { url })
  await waitTrue(client, `document.querySelector('.dba-pin') !== null`, 75000)
  await sleep(1500)
}

await load()

// 1. Open a real conversation so the pin has a session to attach to.
const opened = await evaluate(
  client,
  `(() => {
     const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '') === '新建会话');
     if (!b) return 'no new-session button';
     b.click();
     return 'clicked';
   })()`,
)
console.log('1 open a session   :', opened)
await waitTrue(client, `document.querySelector('.dba-root') !== null`, 20000)
const firstOverlay = await evaluate(client, `document.querySelectorAll('.dba-root').length`)
console.log('  new-conv overlay :', firstOverlay === 1 ? 'played (expected for a blank conversation)' : 'did not play')
// Skipping is a click anywhere on the overlay. Wait out the open grace window
// (SKIP_GRACE_MS) first: a click inside it is deliberately ignored so that the
// second click of the double-click that opened the conversation cannot skip it.
await sleep(600)
await evaluate(client, `(() => { const b = document.querySelector('.dba-root'); if (b) b.click() })()`)
await sleep(800)

// 2. Pin the conversation that is now open.
const before = await evaluate(client, `JSON.stringify({ pins: ${PINS}, disabled: document.querySelector('.dba-pin').disabled })`)
console.log('2 pin before       :', before)
await evaluate(client, `document.querySelector('.dba-pin').click()`)
await sleep(600)
const after = await evaluate(client, `JSON.stringify({ pins: ${PINS}, cls: document.querySelector('.dba-pin').className })`)
console.log('  pin after        :', after)

// 2b. Pin a SECOND conversation: the list must hold both. This is the whole
//     point of the multi-pin change — the old build kept exactly one id, so the
//     first pin silently disappeared here.
await evaluate(
  client,
  `(() => {
     const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '') === '新建会话');
     if (b) b.click();
   })()`,
)
await waitTrue(client, `document.querySelector('.dba-root') !== null`, 20000)
// Skip it (click the overlay), waiting out the open grace window first.
await sleep(600)
await evaluate(client, `(() => { const r = document.querySelector('.dba-root'); if (r) r.click() })()`)
await sleep(800)
await evaluate(client, `document.querySelector('.dba-pin').click()`)
await sleep(600)
const two = await evaluate(client, `JSON.stringify({ pins: ${PINS}, badge: (document.querySelector('.dba-pin-count') || {}).textContent || null })`)
console.log('2b second pin      :', two)

// 2c. The management list: both pins are listed, and 移除 drops one of them
//     without touching the other.
await evaluate(client, `document.querySelector('.dba-lib-open').click()`)
await waitTrue(client, `document.querySelector('.dba-lib') !== null`, 10000)
const listed = await evaluate(
  client,
  `(() => {
     const rows = Array.from(document.querySelectorAll('.dba-pinrow'));
     return JSON.stringify({
       rows: rows.length,
       labels: rows.map((row) => (row.querySelector('.dba-nm') || {}).textContent || ''),
       unpinButtons: document.querySelectorAll('.dba-pinrow .dba-unpin').length,
     });
   })()`,
)
console.log('  list opened      :', listed)
const removed = await evaluate(
  client,
  `(() => {
     const b = document.querySelector('.dba-pinrow .dba-unpin');
     if (!b) return 'no 移除 button';
     b.click();
     return 'clicked';
   })()`,
)
await sleep(600)
const afterRemove = await evaluate(
  client,
  `JSON.stringify({ pins: ${PINS}, rows: document.querySelectorAll('.dba-pinrow').length })`,
)
console.log('  remove one       :', removed, afterRemove)
await evaluate(client, `document.querySelector('.dba-close').click()`)
await sleep(600)

// 3. Block the new-conversation rule for the surviving pinned session.
const armed = await evaluate(
  client,
  `(() => {
     const pins = ${PINS};
     if (pins.length === 0) return 'no pin';
     window.localStorage.setItem('dsh-boot-animation:seen', JSON.stringify(pins.slice(0, 1)));
     return JSON.stringify({ pins, seen: JSON.parse(window.localStorage.getItem('dsh-boot-animation:seen')) });
   })()`,
)
console.log('3 suppress new-conv:', armed)

// 4. Fresh load straight into the pinned conversation.
await evaluate(client, `window.localStorage.removeItem('dsh-boot-animation:seen')`)
await evaluate(client, `window.localStorage.setItem('dsh-boot-animation:seen', JSON.stringify(${PINS}.slice(0, 1)))`)
await load()

const state = await evaluate(
  client,
  `JSON.stringify({ pins: ${PINS}, seen: ${SEEN}, pinDisabled: document.querySelector('.dba-pin') ? document.querySelector('.dba-pin').disabled : null })`,
)
console.log('4 after reload     :', state)

const replayed = await evaluate(client, `document.querySelectorAll('.dba-root').length`)
console.log('  overlay present  :', replayed === 1 ? 'YES -> the PIN rule fired' : 'no')

const video = await evaluate(
  client,
  `(() => {
     const v = document.querySelector('.dba-video');
     return v ? JSON.stringify({ paused: v.paused, duration: v.duration, w: v.videoWidth }) : 'no video';
   })()`,
)
console.log('  video            :', video)

console.log('\nuncaught exceptions:', client.exceptions.length === 0 ? '(none)' : client.exceptions.slice(0, 4))
client.close()
process.exit(0)

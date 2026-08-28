// editorServer.js — hosts the profile editor as a page in the user's browser.
//
// The property inspector panel is about 300px tall, which is the whole reason
// this exists: the editor never fitted, and every attempt to make it fit cost
// something. The plugin is an ordinary Node process, so it can serve a
// full-size page on localhost instead and leave the inspector with the one job
// it is good at — picking which profile a key activates.
//
// The page speaks the same request/reply vocabulary as the inspector. Every
// call lands in `handlePiRequest`, so validation, avatars and the `saveProfiles`
// path are shared rather than reimplemented; only the transport differs.
//
// Security. The page is a browser page, so it is untrusted input even though
// only the local user can open it:
//
//   - bound to 127.0.0.1 on an ephemeral port, never 0.0.0.0;
//   - a token minted per start, carried in the URL and required in a custom
//     header on every API call. Any web page in the browser can POST to
//     127.0.0.1, but it cannot set a custom header without a CORS preflight,
//     and this server answers none;
//   - the Host header must be the loopback address we bound, so a domain that
//     resolves to 127.0.0.1 (DNS rebinding) cannot reach the API;
//   - validation stays server-side in `validateProfiles`, where the page has no
//     way to skip it.

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { handlePiRequest } from './piBridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, '..', 'ui');
const SRC_DIR = resolve(__dirname);

const JS = 'text/javascript; charset=utf-8';

/**
 * The only files this server will hand out, by request path.
 *
 * An allowlist rather than a static file root: there is no directory to walk
 * out of, so path traversal is not a thing that can go wrong here. Each entry
 * names its own directory because one of them is not in `ui/` — contrast.js is
 * shared with the key renderer, and a copy in `ui/` would be a copy that drifts.
 */
const SERVED = {
  '/': { dir: UI_DIR, file: 'editor.html', type: 'text/html; charset=utf-8' },
  '/editorState.js': { dir: UI_DIR, file: 'editorState.js', type: JS },
  '/contrast.js': { dir: SRC_DIR, file: 'contrast.js', type: JS },
};

/** Avatars arrive base64-encoded, so a 2MB image is roughly 2.7MB of body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Grace period between the last page closing and the server stopping.
 *
 * A reload drops the event stream and reopens it a moment later. Stopping on
 * the first disconnect would therefore kill the server every time the user hit
 * refresh, and the reload would land on a dead port.
 */
export const IDLE_STOP_MS = 20_000;

/** Requests that change stored state, so the keys need repainting afterwards. */
const MUTATING = new Set(['saveProfiles', 'uploadAvatar', 'deleteAvatar', 'saveSettings']);

/** The one running server, or null. Two editors would fight over one draft. */
let live = null;

/**
 * Start the editor server, or return the one already running.
 *
 * @param {object} deps
 * @param {object} deps.settings   Stream Deck settings client (global settings)
 * @param {object} [deps.logger]
 * @param {Function} [deps.onChanged]  called after a request that changed state
 * @returns {Promise<{ url: string, port: number, alreadyRunning: boolean }>}
 */
export async function startEditor({ settings, logger = console, onChanged } = {}) {
  if (live) return { url: live.url, port: live.port, alreadyRunning: true };

  const state = {
    token: randomBytes(24).toString('hex'),
    clients: new Set(),
    idleTimer: null,
    settings,
    logger,
    onChanged,
  };

  const server = createServer((req, res) => {
    route(req, res, state).catch((err) => {
      logger.warn?.(`[editor] ${req.method} ${req.url} failed: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'text/plain', 'editor error');
      else res.end();
    });
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    // Port 0 asks the OS for a free port; 127.0.0.1 keeps it off the network.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });

  state.server = server;
  state.port = server.address().port;
  state.url = `http://127.0.0.1:${state.port}/?t=${state.token}`;

  // A half-open socket — the browser process killed rather than the tab closed
  // — never fires 'close', so the server would stay up forever waiting for a
  // page that is gone. Writing to it periodically is what surfaces the break.
  state.ping = setInterval(() => {
    for (const res of state.clients) res.write(': ping\n\n');
  }, 25_000);
  state.ping.unref?.();

  // Nothing has connected yet: if the browser never opens, stop on our own
  // rather than leaving a listening socket behind.
  scheduleStop(state);

  live = state;
  logger.info?.(`[editor] listening on 127.0.0.1:${state.port}`);
  return { url: state.url, port: state.port, alreadyRunning: false };
}

/** Stop the server and drop every open page. Safe to call when not running. */
export async function stopEditor() {
  if (!live) return false;
  const state = live;
  live = null;

  clearTimeout(state.idleTimer);
  clearInterval(state.ping);
  for (const res of state.clients) res.end();
  state.clients.clear();

  // close() alone waits for keep-alive sockets that may never be used again.
  state.server.closeAllConnections?.();
  await new Promise((done) => state.server.close(done));
  state.logger.info?.('[editor] stopped');
  return true;
}

/** Port of the running editor, or null. Exposed for tests and diagnostics. */
export function editorPort() {
  return live?.port ?? null;
}

/**
 * Open the user's default browser at the editor.
 *
 * `start` is a cmd builtin rather than an executable, and its first argument is
 * the window title — omitting the empty title makes it treat the URL as the
 * title and open nothing.
 */
export function openInBrowser(url, { spawnFn = spawn, logger = console } = {}) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawnFn(command, args, { detached: true, stdio: 'ignore' });
    // An unhandled 'error' event on a child process is fatal to the plugin, and
    // a browser that will not launch must not take the plugin down with it —
    // the inspector shows the URL, which is enough to recover by hand.
    child?.on?.('error', (err) => logger.warn?.(`[editor] could not open browser: ${err.message}`));
    child?.unref?.();
    return true;
  } catch (err) {
    logger.warn?.(`[editor] could not open browser: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(req, res, state) {
  if (req.headers.host !== `127.0.0.1:${state.port}`) {
    return send(res, 403, 'text/plain', 'editor is loopback only');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  const asset = req.method === 'GET' ? SERVED[url.pathname] : null;
  if (asset) {
    if (!tokenOk(state, url.searchParams.get('t'))) return send(res, 403, 'text/plain', 'bad token');
    // The token stays in the address bar deliberately: strip it and a reload
    // has nothing to authenticate with.
    return send(res, 200, asset.type, readFileSync(resolve(asset.dir, asset.file)), {
      // The page reaches nothing but this server; anything outward would be an
      // injection, so refuse it at the browser rather than trusting review.
      'content-security-policy':
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline' 'self'; connect-src 'self'; form-action 'none'",
    });
  }

  // EventSource cannot set headers, so the stream authenticates by query string.
  if (req.method === 'GET' && url.pathname === '/events') {
    if (!tokenOk(state, url.searchParams.get('t'))) return send(res, 403, 'text/plain', 'bad token');
    return attachEventStream(req, res, state);
  }

  if (req.method === 'POST' && url.pathname === '/api') {
    if (!tokenOk(state, req.headers['x-rig-editor'])) return send(res, 403, 'text/plain', 'bad token');
    return handleApi(req, res, state);
  }

  send(res, 404, 'text/plain', 'not found');
}

async function handleApi(req, res, state) {
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: err.message }));
  }

  const reply = await handlePiRequest(msg, { settings: state.settings, logger: state.logger });

  // Repaint the deck for the same requests the inspector repaints on: a profile
  // renamed in the browser must not leave the old name on the key.
  if (MUTATING.has(msg?.request) && reply.ok !== false) {
    try {
      await state.onChanged?.(msg.request);
    } catch (err) {
      state.logger.warn?.(`[editor] repaint after ${msg.request} failed: ${err.message}`);
    }
  }

  send(res, 200, 'application/json', JSON.stringify(reply));
}

/**
 * The event stream exists for lifetime, not for data: an open stream means a
 * page is open, and its close is the signal to shut down. That is the whole
 * reason the server can start on demand and not linger.
 */
function attachEventStream(req, res, state) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');

  state.clients.add(res);
  clearTimeout(state.idleTimer);
  state.idleTimer = null;

  req.on('close', () => {
    state.clients.delete(res);
    if (state.clients.size === 0) scheduleStop(state);
  });
}

function scheduleStop(state) {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (live === state && state.clients.size === 0) {
      stopEditor().catch((err) => state.logger.warn?.(`[editor] stop failed: ${err.message}`));
    }
  }, IDLE_STOP_MS);
  state.idleTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenOk(state, candidate) {
  const given = Buffer.from(String(candidate ?? ''));
  const wanted = Buffer.from(state.token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // Refuse before buffering the rest: an oversized upload must not be able
      // to grow the plugin's heap on the way to being rejected.
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return fail(new Error('request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': type,
    // No sniffing, no caching: the page changes as the plugin is developed and
    // a stale cached copy against a new API is a confusing failure.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

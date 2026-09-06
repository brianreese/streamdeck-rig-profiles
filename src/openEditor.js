// openEditor.js — start the settings editor and put it in front of the user.
//
// Two callers want exactly this: the property inspector's "Open editor" button
// and the deck key that does the same without going through the Stream Deck app
// at all. They were one copy-and-paste from disagreeing about which services the
// editor is given, which is the kind of difference nobody notices until a page
// that looks fine answers 503.
//
// `startEditor` is idempotent: a second call returns the running server's URL
// rather than binding a second port, which is what makes pressing the key twice
// harmless.
//
// The editor module is imported lazily, exactly as the property inspector did
// it: the server, its token and its dependencies cost nothing on a rig that
// never opens the editor.

/**
 * @param {object} deps
 * @param {object} deps.settings              the Stream Deck settings port
 * @param {object} [deps.logger]
 * @param {Function} [deps.onChanged]         repaint hook, passed to the server
 * @param {Function} [deps.load]              injected for tests; imports editorServer.js
 * @returns {Promise<{url: string, alreadyRunning: boolean}>}
 */
export async function openEditor({
  settings,
  logger = console,
  onChanged,
  load = () => import('./editorServer.js'),
}) {
  const { startEditor, openInBrowser } = await load();
  const { url, alreadyRunning } = await startEditor({ settings, logger, onChanged });

  // Best-effort, and swallowed on purpose: the editor is RUNNING by this point,
  // so a browser that refuses to launch is not a failure of this operation and
  // must not be reported as one. The warning names the URL, which is the one
  // thing that lets the job be finished by hand.
  try {
    openInBrowser(url, { logger });
  } catch (err) {
    logger.warn?.(`[editor] running at ${url}, but the browser did not open: ${err.message}`);
  }

  return { url, alreadyRunning };
}

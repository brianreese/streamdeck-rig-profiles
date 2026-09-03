// openEditor, in its own file so the editor server can be mocked statically.
//
// These two tests used to live in piBridge.test.js and mock the module the
// dynamic way — `vi.resetModules()`, then `vi.doMock`, then `await import`.
// That is order-dependent, and roughly one run in forty the mock did not take:
// piBridge got the REAL editorServer, the assertion failed with `ok: true`, and
// a socket was left bound by a test that never meant to open one.
//
// `vi.mock` is hoisted above the imports, so the mock is in place before
// piBridge is ever resolved. Nothing to reset, nothing to order, and the real
// server can never start — which matters, because the real one binds a port and
// opens a browser window on whoever runs the tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Behaviour is swapped per test through these, since the factory is hoisted and
// cannot close over anything defined later.
const editor = {
  startEditor: vi.fn(),
  openInBrowser: vi.fn(),
};

vi.mock('./editorServer.js', () => ({
  startEditor: (...args) => editor.startEditor(...args),
  openInBrowser: (...args) => editor.openInBrowser(...args),
}));

const { handlePiRequest } = await import('./piBridge.js');

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const fakeSettings = (initial = {}) => ({
  async getGlobalSettings() { return initial; },
  async setGlobalSettings() {},
});

beforeEach(() => {
  editor.startEditor.mockReset();
  editor.openInBrowser.mockReset();
});

describe('openEditor', () => {
  it('starts the browser editor and hands back its address', async () => {
    editor.startEditor.mockResolvedValue({ url: 'http://127.0.0.1:1234/?t=abc', alreadyRunning: false });
    const repaint = () => {};

    const reply = await handlePiRequest(
      { request: 'openEditor' },
      { settings: fakeSettings(), logger: silent, onChanged: repaint },
    );

    expect(reply).toMatchObject({ ok: true, url: 'http://127.0.0.1:1234/?t=abc' });
    expect(editor.openInBrowser).toHaveBeenCalledWith('http://127.0.0.1:1234/?t=abc', expect.anything());
    // The editor saves without the inspector in the loop, so the repaint hook
    // has to reach it or the keys keep the old names.
    expect(editor.startEditor.mock.calls[0][0].onChanged).toBe(repaint);
  });

  it('reports a server that will not start instead of throwing at the inspector', async () => {
    editor.startEditor.mockRejectedValue(new Error('EADDRINUSE'));

    const reply = await handlePiRequest(
      { request: 'openEditor' },
      { settings: fakeSettings(), logger: { ...silent, error: () => {} } },
    );

    expect(reply).toMatchObject({ ok: false, error: 'EADDRINUSE' });
    expect(editor.openInBrowser).not.toHaveBeenCalled();
  });
});

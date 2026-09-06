// editorKey.test.js — the key that opens the settings editor.
//
// `open` is injected, so nothing here binds a port or opens a browser window on
// whoever runs the tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import streamDeck from '@elgato/streamdeck';
import { EditorKey } from './editorKey.js';

// The real SDK, not a mock: vitest.setup.js already makes importing it safe, and
// mocking it here fought the hoisting rules for no gain. Only the log is spied.

const key = () => ({
  id: 'key-1',
  setImage: vi.fn(async () => {}),
  showOk: vi.fn(async () => {}),
  showAlert: vi.fn(async () => {}),
});

let errors;
beforeEach(() => {
  errors = vi.spyOn(streamDeck.logger, 'error').mockImplementation(() => {});
  vi.spyOn(streamDeck.logger, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the editor key', () => {
  it('opens the editor and says so on the key', async () => {
    const open = vi.fn(async () => ({ url: 'http://127.0.0.1:1234/?t=abc', alreadyRunning: false }));
    const k = key();

    await new EditorKey({ open }).onKeyUp({ action: k });

    expect(open).toHaveBeenCalledOnce();
    expect(k.showOk).toHaveBeenCalled();
    expect(k.showAlert).not.toHaveBeenCalled();
  });

  it('hands the editor the settings port and a repaint hook', async () => {
    const open = vi.fn(async () => ({ url: 'u', alreadyRunning: false }));
    await new EditorKey({ open }).onKeyUp({ action: key() });
    const passed = open.mock.calls[0][0];
    expect(passed.settings).toBeTruthy();
    expect(typeof passed.onChanged).toBe('function');
  });

  it('is harmless pressed twice — the server is not started again', async () => {
    const open = vi.fn(async () => ({ url: 'u', alreadyRunning: true }));
    const k = key();
    const action = new EditorKey({ open });
    await action.onKeyUp({ action: k });
    await action.onKeyUp({ action: k });
    expect(k.showAlert).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('alerts and logs when the editor will not start', async () => {
    const open = vi.fn(async () => {
      throw new Error('EADDRINUSE');
    });
    const k = key();
    await new EditorKey({ open }).onKeyUp({ action: k });
    expect(k.showAlert).toHaveBeenCalled();
    expect(k.showOk).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });

  it('paints itself without touching the rig', async () => {
    const k = key();
    await new EditorKey({ open: vi.fn() }).onWillAppear({ action: k });
    expect(k.setImage).toHaveBeenCalled();
  });
});

// openEditor.test.js — the step both the key and the property inspector take.
//
// `load` is injected, so the real editor server is never imported here and no
// port is bound.

import { describe, it, expect, vi } from 'vitest';
import { openEditor } from './openEditor.js';

const silent = { info() {}, error() {}, warn: vi.fn(), debug() {} };

const load = (over = {}) => async () => ({
  startEditor: vi.fn(async () => ({ url: 'http://127.0.0.1:1234/?t=abc', alreadyRunning: false })),
  openInBrowser: vi.fn(),
  ...over,
});

describe('openEditor', () => {
  it('starts the server and opens a browser at its address', async () => {
    const openInBrowser = vi.fn();
    const result = await openEditor({
      settings: 'S',
      logger: silent,
      onChanged: () => {},
      load: load({ openInBrowser }),
    });
    expect(result).toEqual({ url: 'http://127.0.0.1:1234/?t=abc', alreadyRunning: false });
    expect(openInBrowser).toHaveBeenCalledWith('http://127.0.0.1:1234/?t=abc', expect.anything());
  });

  it('passes the settings port and repaint hook straight through', async () => {
    const startEditor = vi.fn(async () => ({ url: 'u', alreadyRunning: false }));
    const onChanged = () => {};
    await openEditor({ settings: 'S', logger: silent, onChanged, load: load({ startEditor }) });
    expect(startEditor).toHaveBeenCalledWith({ settings: 'S', logger: silent, onChanged });
  });

  it('still succeeds when the browser refuses to launch', async () => {
    // The editor IS running by then, so reporting a failure would both hide the
    // URL and describe something that did not happen.
    const warn = vi.fn();
    const result = await openEditor({
      settings: 'S',
      logger: { ...silent, warn },
      load: load({
        openInBrowser: () => {
          throw new Error('no browser');
        },
      }),
    });
    expect(result.url).toBe('http://127.0.0.1:1234/?t=abc');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:1234/?t=abc'));
  });

  it('reports a server that will not start', async () => {
    await expect(
      openEditor({
        settings: 'S',
        logger: silent,
        load: load({
          startEditor: async () => {
            throw new Error('EADDRINUSE');
          },
        }),
      }),
    ).rejects.toThrow('EADDRINUSE');
  });
});

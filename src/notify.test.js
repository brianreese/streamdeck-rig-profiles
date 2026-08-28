import { describe, it, expect, vi } from 'vitest';
import { notify, buildScript } from './notify.js';

const fakeSpawn = () => {
  const calls = [];
  const fn = vi.fn((command, args, options) => {
    calls.push({ command, args, options });
    return { unref: vi.fn(), on: vi.fn() };
  });
  return { fn, calls };
};

/** Recover the script the way PowerShell would, to assert on what it runs. */
const decode = (calls) =>
  Buffer.from(calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

describe('buildScript', () => {
  it('escapes XML so a quote in a name cannot break the document', () => {
    const script = buildScript("O'Brien & <Kai>", 'travel end is 0.00, wanted 8.1');
    expect(script).toContain('O&apos;Brien &amp; &lt;Kai&gt;');
    expect(script).not.toContain('<Kai>');
  });

  it('trims a long provider detail rather than emitting a wall of text', () => {
    const script = buildScript('Kai', 'x'.repeat(400));
    expect(script).toContain('…');
    expect(script.match(/x+/)[0].length).toBeLessThan(200);
  });

  it('auto-dismisses', () => {
    expect(buildScript('a', 'b')).toContain('duration="short"');
  });
});

describe('notify', () => {
  it('passes the script base64-encoded, never on the command line', () => {
    const { fn, calls } = fakeSpawn();
    notify('Kai', 'MOZA mismatch', { spawnFn: fn, platform: 'win32' });

    expect(calls[0].command).toBe('powershell.exe');
    // The text must not appear as an argument, where quoting could break it.
    expect(calls[0].args.join(' ')).not.toContain('MOZA mismatch');
    expect(decode(calls)).toContain('MOZA mismatch');
  });

  it('detaches so a profile switch never waits on a toast', () => {
    const { fn, calls } = fakeSpawn();
    notify('a', 'b', { spawnFn: fn, platform: 'win32' });
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].options.stdio).toBe('ignore');
  });

  it('does nothing off Windows instead of spawning powershell', () => {
    const { fn } = fakeSpawn();
    expect(notify('a', 'b', { spawnFn: fn, platform: 'darwin' })).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('never throws, because it is itself the fallback for a failure', () => {
    const boom = () => {
      throw new Error('spawn failed');
    };
    const warned = [];
    expect(() =>
      notify('a', 'b', { spawnFn: boom, platform: 'win32', logger: { warn: (m) => warned.push(m) } }),
    ).not.toThrow();
    expect(warned[0]).toMatch(/spawn failed/);
  });
});

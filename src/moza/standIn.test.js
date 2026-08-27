import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateExeName, runStandIn } from './standIn.js';

function fakeSpawn() {
  const calls = [];
  const fn = (path, args, opts) => {
    calls.push({ path, args, opts });
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => calls.push({ killed: true });
    return child;
  };
  fn.calls = calls;
  return fn;
}

describe('validateExeName', () => {
  it('accepts a plain executable name', () => {
    expect(validateExeName('TokyoXtremeRacer.exe')).toBeNull();
    expect(validateExeName('F1_25.exe')).toBeNull();
    expect(validateExeName('Dakar 2 Game.exe')).toBeNull();
  });

  it('requires a name at all', () => {
    expect(validateExeName('')).toMatch(/no trigger/);
    expect(validateExeName(undefined)).toMatch(/no trigger/);
  });

  it('requires the .exe suffix', () => {
    expect(validateExeName('TokyoXtremeRacer')).toMatch(/plain \.exe/);
  });

  it('rejects anything path-like, so the copy cannot escape its folder', () => {
    expect(validateExeName('..\\..\\evil.exe')).toMatch(/plain \.exe/);
    expect(validateExeName('C:\\Windows\\System32\\cmd.exe')).toMatch(/plain \.exe/);
    expect(validateExeName('sub/dir/game.exe')).toMatch(/plain \.exe/);
  });

  it('rejects shell metacharacters', () => {
    expect(validateExeName('game.exe & del *')).toMatch(/plain \.exe/);
    expect(validateExeName('game.exe;rm')).toMatch(/plain \.exe/);
  });
});

describe('runStandIn', () => {
  const stage = () => mkdtempSync(join(tmpdir(), 'standin-'));

  it('stages a copy under the requested name and runs it', async () => {
    const dir = stage();
    const spawnFn = fakeSpawn();
    const out = await runStandIn('TokyoXtremeRacer.exe', { dir, spawnFn, lingerMs: 1 });

    expect(existsSync(join(dir, 'TokyoXtremeRacer.exe'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['TokyoXtremeRacer.exe']);
    expect(out.pid).toBe(4242);
    expect(spawnFn.calls[0].path).toBe(join(dir, 'TokyoXtremeRacer.exe'));
  });

  it('hides the window so a profile switch is not visually noisy', async () => {
    const spawnFn = fakeSpawn();
    await runStandIn('game.exe', { dir: stage(), spawnFn, lingerMs: 1 });
    expect(spawnFn.calls[0].opts.windowsHide).toBe(true);
  });

  it('gives the stand-in a self-timeout longer than the linger', async () => {
    // A missed kill must not leave a process running forever.
    const spawnFn = fakeSpawn();
    await runStandIn('game.exe', { dir: stage(), spawnFn, lingerMs: 3000 });
    const timeout = Number(spawnFn.calls[0].args.at(-1));
    expect(timeout).toBeGreaterThan(3);
  });

  it('stops the stand-in once it has lingered', async () => {
    const spawnFn = fakeSpawn();
    await runStandIn('game.exe', { dir: stage(), spawnFn, lingerMs: 1 });
    expect(spawnFn.calls.some((c) => c.killed)).toBe(true);
  });

  it('refuses an invalid name before copying anything', async () => {
    const dir = stage();
    await expect(runStandIn('../escape.exe', { dir, spawnFn: fakeSpawn() })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

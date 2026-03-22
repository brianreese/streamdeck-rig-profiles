// fanatec.test.js — unit tests for src/fanatec.js
//
// parseHotkey is a pure function — zero mocking required.
// activatePreset uses an injectable `_robot` dependency so the robotjs native
// binary is never loaded during unit tests.

import { describe, it, expect, vi } from 'vitest';
import { parseHotkey, activatePreset } from './fanatec.js';

// ---------------------------------------------------------------------------
// parseHotkey
// ---------------------------------------------------------------------------

describe('parseHotkey', () => {
  it('extracts the key from a single-token string', () => {
    expect(parseHotkey('f1')).toEqual({ mods: [], key: 'f1' });
  });

  it('extracts key and a single modifier', () => {
    expect(parseHotkey('shift+a')).toEqual({ mods: ['shift'], key: 'a' });
  });

  it('extracts key and multiple modifiers', () => {
    expect(parseHotkey('ctrl+alt+f1')).toEqual({ mods: ['control', 'alt'], key: 'f1' });
  });

  it('normalises ctrl → control', () => {
    expect(parseHotkey('ctrl+x').mods).toContain('control');
  });

  it('normalises cmd → command', () => {
    expect(parseHotkey('cmd+space').mods).toContain('command');
  });

  it('normalises win → command', () => {
    expect(parseHotkey('win+r').mods).toContain('command');
  });

  it('normalises opt → alt', () => {
    expect(parseHotkey('opt+tab').mods).toContain('alt');
  });

  it('normalises option → alt', () => {
    expect(parseHotkey('option+tab').mods).toContain('alt');
  });

  it('passes through canonical names unchanged (shift, alt, control, command)', () => {
    const { mods } = parseHotkey('control+alt+shift+f2');
    expect(mods).toEqual(['control', 'alt', 'shift']);
  });

  it('is case-insensitive', () => {
    expect(parseHotkey('CTRL+ALT+F1')).toEqual({ mods: ['control', 'alt'], key: 'f1' });
  });

  it('trims whitespace around tokens', () => {
    expect(parseHotkey('ctrl + alt + f1')).toEqual({ mods: ['control', 'alt'], key: 'f1' });
  });

  it('returns empty mods array for bare key', () => {
    expect(parseHotkey('escape').mods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// activatePreset
// ---------------------------------------------------------------------------

describe('activatePreset', () => {
  function makeRobot() {
    return { keyTap: vi.fn() };
  }

  it('fires keyTap with the parsed key and mods', () => {
    const robot = makeRobot();
    activatePreset('ctrl+alt+f1', { _robot: robot });
    expect(robot.keyTap).toHaveBeenCalledOnce();
    expect(robot.keyTap).toHaveBeenCalledWith('f1', ['control', 'alt']);
  });

  it('fires keyTap with an empty mods array for a bare key', () => {
    const robot = makeRobot();
    activatePreset('f2', { _robot: robot });
    expect(robot.keyTap).toHaveBeenCalledWith('f2', []);
  });

  it('is a no-op when hotkeyStr is null', () => {
    const robot = makeRobot();
    activatePreset(null, { _robot: robot });
    expect(robot.keyTap).not.toHaveBeenCalled();
  });

  it('is a no-op when hotkeyStr is undefined', () => {
    const robot = makeRobot();
    activatePreset(undefined, { _robot: robot });
    expect(robot.keyTap).not.toHaveBeenCalled();
  });

  it('is a no-op when hotkeyStr is an empty string', () => {
    const robot = makeRobot();
    activatePreset('', { _robot: robot });
    expect(robot.keyTap).not.toHaveBeenCalled();
  });

  it('normalises modifier aliases before firing', () => {
    const robot = makeRobot();
    activatePreset('cmd+shift+3', { _robot: robot });
    expect(robot.keyTap).toHaveBeenCalledWith('3', ['command', 'shift']);
  });
});

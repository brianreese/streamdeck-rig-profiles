import { describe, it, expect } from 'vitest';
import { isServiceRunning, ensureServiceRunning, locateService, SERVICE_EXE } from './fanatecService.js';

const listing = (running) => ({
  stdout: running
    ? `${SERVICE_EXE}                  49816 Console                    1     45,000 K`
    : 'INFO: No tasks are running which match the specified criteria.',
});

const fakeSpawn = () => {
  const calls = [];
  const fn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return { unref: () => {} };
  };
  fn.calls = calls;
  return fn;
};

describe('isServiceRunning', () => {
  it('detects the service in tasklist output', async () => {
    expect(await isServiceRunning({ exec: async () => listing(true) })).toBe(true);
  });

  it('reports absent when tasklist finds nothing', async () => {
    expect(await isServiceRunning({ exec: async () => listing(false) })).toBe(false);
  });

  it('assumes running when tasklist itself fails', async () => {
    // Guessing "not running" would start a second copy on a bad signal.
    const exec = async () => {
      throw new Error('tasklist unavailable');
    };
    expect(await isServiceRunning({ exec })).toBe(true);
  });
});

describe('ensureServiceRunning', () => {
  const env = { FANATEC_SERVICE_EXE: __filename }; // any existing file

  it('does nothing when the service is already up', async () => {
    const spawnFn = fakeSpawn();
    const out = await ensureServiceRunning({ env, exec: async () => listing(true), spawnFn });
    expect(out).toEqual({ started: false, ok: true });
    expect(spawnFn.calls).toHaveLength(0);
  });

  it('starts it detached and hidden when it is missing', async () => {
    const spawnFn = fakeSpawn();
    // Absent until we launch it, present afterwards.
    const exec = async () => listing(spawnFn.calls.length > 0);

    const out = await ensureServiceRunning({ env, exec, spawnFn, pollMs: 1 });

    expect(out).toEqual({ started: true, ok: true });
    // Detached so it outlives the plugin; hidden so a switch is not noisy.
    expect(spawnFn.calls[0].opts).toMatchObject({ detached: true, windowsHide: true });
  });

  it('reports clearly when the executable cannot be found', async () => {
    const out = await ensureServiceRunning({
      env: { FANATEC_SERVICE_EXE: 'C:\\nope\\missing.exe', ProgramFiles: 'C:\\nope' },
      exec: async () => listing(false),
      spawnFn: fakeSpawn(),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not found/);
  });

  it('gives up rather than hanging when it never appears', async () => {
    const out = await ensureServiceRunning({
      env,
      exec: async () => listing(false),
      spawnFn: fakeSpawn(),
      waitMs: 20,
      pollMs: 5,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/did not come up/);
  });

  it('surfaces a spawn failure instead of throwing', async () => {
    const out = await ensureServiceRunning({
      env,
      exec: async () => listing(false),
      spawnFn: () => {
        throw new Error('EACCES');
      },
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/EACCES/);
  });
});

describe('locateService', () => {
  it('returns null when no candidate exists', () => {
    expect(locateService({ ProgramFiles: 'C:\\nope', 'ProgramFiles(x86)': 'C:\\nope' })).toBeNull();
  });
});

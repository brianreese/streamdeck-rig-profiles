import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import apps, { parseCommands, _resetForTesting } from './apps.js';
import { STATUS } from './status.js';

/** A fake child process that can be told how to finish. */
function fakeSpawn({ exitCode = 0, throwOn = null, errorOn = null } = {}) {
  const calls = [];
  const fn = (command, options) => {
    calls.push({ command, options });
    if (throwOn && command.includes(throwOn)) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      if (errorOn && command.includes(errorOn)) child.emit('error', new Error('ENOENT'));
      else child.emit('exit', exitCode);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => _resetForTesting());

describe('parseCommands', () => {
  it('takes one command per line', () => {
    expect(parseCommands('a.exe\nb.exe')).toEqual(['a.exe', 'b.exe']);
  });

  it('ignores blank lines and # comments', () => {
    expect(parseCommands('a.exe\n\n  # note\n  b.exe  ')).toEqual(['a.exe', 'b.exe']);
  });

  it('treats missing input as no commands', () => {
    expect(parseCommands(undefined)).toEqual([]);
    expect(parseCommands('   ')).toEqual([]);
  });
});

describe('apply', () => {
  it('runs commands in order, since they often depend on each other', async () => {
    const spawnFn = fakeSpawn();
    await apps.apply({ commands: 'first.exe\nsecond.exe', wait: true }, { profileId: 'p', spawnFn });
    expect(spawnFn.calls.map((c) => c.command)).toEqual(['first.exe', 'second.exe']);
  });

  it('detaches when not waiting, so an app outlives the plugin', async () => {
    const spawnFn = fakeSpawn();
    await apps.apply({ commands: 'app.exe' }, { profileId: 'p', spawnFn });
    expect(spawnFn.calls[0].options.detached).toBe(true);
  });

  it('does not detach when waiting for an exit code', async () => {
    const spawnFn = fakeSpawn();
    await apps.apply({ commands: 'script.bat', wait: true }, { profileId: 'p', spawnFn });
    expect(spawnFn.calls[0].options.detached).toBe(false);
  });
});

describe('verify', () => {
  it('is skipped when nothing is configured', async () => {
    await apps.apply({ commands: '' }, { profileId: 'p' });
    expect((await apps.verify({ commands: '' }, { profileId: 'p' })).status).toBe(STATUS.SKIPPED);
  });

  it('verifies when waited-on commands all exit 0', async () => {
    const cfg = { commands: 'ok.exe', wait: true };
    await apps.apply(cfg, { profileId: 'p', spawnFn: fakeSpawn({ exitCode: 0 }) });
    expect((await apps.verify(cfg, { profileId: 'p' })).status).toBe(STATUS.VERIFIED);
  });

  it('fails on a non-zero exit code', async () => {
    const cfg = { commands: 'bad.exe', wait: true };
    await apps.apply(cfg, { profileId: 'p', spawnFn: fakeSpawn({ exitCode: 3 }) });
    const out = await apps.verify(cfg, { profileId: 'p' });
    expect(out.status).toBe(STATUS.FAILED);
    expect(out.detail).toContain('exited 3');
  });

  it('reports a launch it cannot confirm as unverified, not verified', async () => {
    // Fire-and-forget tells us the process started, never that it did its job.
    const cfg = { commands: 'app.exe' };
    await apps.apply(cfg, { profileId: 'p', spawnFn: fakeSpawn() });
    expect((await apps.verify(cfg, { profileId: 'p' })).status).toBe(STATUS.APPLIED_UNVERIFIED);
  });

  it('fails when a command cannot be spawned at all', async () => {
    const cfg = { commands: 'missing.exe', wait: true };
    await apps.apply(cfg, { profileId: 'p', spawnFn: fakeSpawn({ errorOn: 'missing' }) });
    const out = await apps.verify(cfg, { profileId: 'p' });
    expect(out.status).toBe(STATUS.FAILED);
    expect(out.detail).toContain('ENOENT');
  });

  it('keeps results separate per profile', async () => {
    const good = { commands: 'ok.exe', wait: true };
    const bad = { commands: 'bad.exe', wait: true };
    await apps.apply(good, { profileId: 'a', spawnFn: fakeSpawn({ exitCode: 0 }) });
    await apps.apply(bad, { profileId: 'b', spawnFn: fakeSpawn({ exitCode: 1 }) });
    expect((await apps.verify(good, { profileId: 'a' })).status).toBe(STATUS.VERIFIED);
    expect((await apps.verify(bad, { profileId: 'b' })).status).toBe(STATUS.FAILED);
  });
});

describe('schema', () => {
  it('describes its own fields so the editor needs no knowledge of it', () => {
    const keys = apps.schema().map((f) => f.key);
    expect(keys).toEqual(['commands', 'wait']);
    expect(apps.schema()[0].type).toBe('textarea');
    expect(apps.schema()[1].type).toBe('boolean');
  });
});

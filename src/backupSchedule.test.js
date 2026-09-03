import { describe, it, expect, vi, afterEach } from 'vitest';
import { noteWrite, checkpointNow, cancel, isPending, flush, SETTLE_MS } from './backupSchedule.js';

afterEach(() => {
  cancel();
  vi.useRealTimers();
});

const blob = { profiles: [{ id: 'brian' }] };

describe('settling', () => {
  it('writes nothing until the config stops changing', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    noteWrite(blob, { write });
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][1]).toMatchObject({ checkpoint: true, reason: 'settled' });
  });

  it('collapses a burst of autosaves into one generation', () => {
    // The whole point. Twenty writes while someone types used to mean twenty
    // generations, which aged a fortnight of history out in one evening.
    vi.useFakeTimers();
    const write = vi.fn();
    for (let i = 0; i < 20; i++) {
      noteWrite({ profiles: [{ id: `p${i}` }] }, { write });
      vi.advanceTimersByTime(1_000);
    }
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(write).toHaveBeenCalledOnce();
  });

  it('captures what was written, not whatever is current when it fires', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const first = { profiles: [{ id: 'first' }] };
    noteWrite(first, { write });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(write.mock.calls[0][0]).toBe(first);
  });

  it('survives the write throwing', () => {
    vi.useFakeTimers();
    const log = vi.fn();
    noteWrite(blob, { write: () => { throw new Error('disk full'); }, log });
    expect(() => vi.advanceTimersByTime(SETTLE_MS)).not.toThrow();
    expect(log.mock.calls[0][0]).toMatch(/disk full/);
  });
});

describe('risky moments', () => {
  it('writes immediately with its reason', () => {
    const write = vi.fn(() => ({ generation: 'x' }));
    checkpointNow(blob, 'before-restore', { write });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][1]).toMatchObject({ checkpoint: true, reason: 'before-restore' });
  });

  it('cancels a pending settle, so one edit does not spend two slots', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    noteWrite(blob, { write });
    expect(isPending()).toBe(true);
    checkpointNow(blob, 'startup', { write });
    expect(isPending()).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(write).toHaveBeenCalledOnce();
  });

  it('never throws at the caller', () => {
    const log = vi.fn();
    expect(() => checkpointNow(blob, 'startup', {
      write: () => { throw new Error('nope'); }, log,
    })).not.toThrow();
  });
});

describe('flush', () => {
  it('writes a pending generation now, for shutdown', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    noteWrite(blob, { write });
    flush({ write });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][1].reason).toBe('flushed');
    expect(isPending()).toBe(false);
  });

  it('does nothing when nothing is pending', () => {
    const write = vi.fn();
    expect(flush({ write })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

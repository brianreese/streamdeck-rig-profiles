import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { deflateRawSync } from 'zlib';
import {
  parseIni,
  listPresets,
  readPreset,
  readSelection,
  isPresetSelected,
  resolvePitHouseDir,
} from './presetStore.js';

/** Build a throwaway Pit House library mirroring the real layout. */
function makeLibrary(presets = [], ini = null) {
  const dir = mkdtempSync(join(tmpdir(), 'pithouse-'));
  const pedals = join(dir, 'Presets', 'Pedals');
  mkdirSync(pedals, { recursive: true });
  for (const p of presets) {
    writeFileSync(join(pedals, `${p.id}.json`), JSON.stringify(p), 'utf8');
  }
  if (ini !== null) writeFileSync(join(dir, 'Presets', 'config.ini'), ini, 'utf8');
  return dir;
}

const preset = (over = {}) => ({
  id: 'aaa',
  name: 'A Preset',
  deviceType: 'Pedals',
  devices: ['mBooster'],
  isOfficial: false,
  lastModified: 100,
  deviceParams: { brake_forcelimit_max: 80, brake_damping_press: 20 },
  ...over,
});

describe('parseIni', () => {
  it('reads sections and keys', () => {
    const out = parseIni('[LastUsedPreset]\n0f7d=c903\n\n[IsAutoLoadPreset]\nMBoost=true\n');
    expect(out.LastUsedPreset['0f7d']).toBe('c903');
    expect(out.IsAutoLoadPreset.MBoost).toBe('true');
  });

  it('ignores comments and blank lines', () => {
    const out = parseIni('; note\n\n[A]\nx=1\n# other\n');
    expect(out.A).toEqual({ x: '1' });
  });

  it('keeps values containing an equals sign intact', () => {
    expect(parseIni('[A]\nk=a=b\n').A.k).toBe('a=b');
  });

  it('returns an empty object for junk rather than throwing', () => {
    expect(parseIni('not an ini at all')).toEqual({});
    expect(parseIni(null)).toEqual({});
  });
});

describe('listPresets', () => {
  it('lists presets with their names and parameter counts', () => {
    const dir = makeLibrary([preset()]);
    const [p] = listPresets({ dir });
    expect(p.name).toBe('A Preset');
    expect(p.paramCount).toBe(2);
  });

  it('filters to presets for the requested device', () => {
    const dir = makeLibrary([
      preset({ id: 'a', name: 'Booster one', devices: ['mBooster'] }),
      preset({ id: 'b', name: 'CRP one', devices: ['CRP2'] }),
    ]);
    const names = listPresets({ dir, device: 'mBooster' }).map((p) => p.name);
    expect(names).toEqual(['Booster one']);
  });

  it('treats MBoost and mBooster as the same pedal', () => {
    // Pit House spells it both ways across config.ini and preset files.
    const dir = makeLibrary([preset({ devices: ['MBoost'] })]);
    expect(listPresets({ dir, device: 'mBooster' })).toHaveLength(1);
  });

  it('keeps presets that declare no device, rather than hiding them', () => {
    const dir = makeLibrary([preset({ devices: [] })]);
    expect(listPresets({ dir, device: 'mBooster' })).toHaveLength(1);
  });

  it('puts your own presets before official ones', () => {
    const dir = makeLibrary([
      preset({ id: 'off', name: 'Official', isOfficial: true, lastModified: 999 }),
      preset({ id: 'mine', name: 'Mine', isOfficial: false, lastModified: 1 }),
    ]);
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Mine', 'Official']);
  });

  it('skips a malformed preset instead of failing the whole list', () => {
    const dir = makeLibrary([preset({ id: 'good', name: 'Good' })]);
    writeFileSync(join(dir, 'Presets', 'Pedals', 'broken.json'), '{ not json', 'utf8');
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Good']);
  });

  it('returns an empty list when the library is missing', () => {
    expect(listPresets({ dir: join(tmpdir(), 'nope-does-not-exist') })).toEqual([]);
    expect(listPresets({ dir: null })).toEqual([]);
  });
});

describe('readPreset', () => {
  it('returns the full preset including deviceParams', () => {
    const dir = makeLibrary([preset()]);
    expect(readPreset('aaa', { dir }).deviceParams.brake_forcelimit_max).toBe(80);
  });

  it('returns null for a preset that no longer exists', () => {
    expect(readPreset('gone', { dir: makeLibrary([]) })).toBeNull();
  });
});

describe('readSelection', () => {
  it('reads the loaded preset per device and the auto-load flags', () => {
    const dir = makeLibrary(
      [],
      '[LastUsedPreset]\n0f7d598567382e66=c903ac57\n\n[IsAutoLoadPreset]\nMBoost=true\n',
    );
    const sel = readSelection({ dir });
    expect(sel.lastUsed['0f7d598567382e66']).toBe('c903ac57');
    expect(sel.autoLoad.MBoost).toBe(true);
  });

  it('is empty rather than throwing when config.ini is absent', () => {
    expect(readSelection({ dir: makeLibrary([]) })).toEqual({ lastUsed: {}, autoLoad: {} });
  });

  it('reports whether a given preset is the loaded one', () => {
    const dir = makeLibrary([], '[LastUsedPreset]\ndev=abc\n');
    expect(isPresetSelected('abc', { dir })).toBe(true);
    expect(isPresetSelected('xyz', { dir })).toBe(false);
  });
});

describe('resolvePitHouseDir', () => {
  it('returns null when no candidate exists', () => {
    expect(resolvePitHouseDir({ home: join(tmpdir(), 'no-such-home'), env: {} })).toBeNull();
  });

  it('honours an explicit override', () => {
    // Documents is often redirected into OneDrive, so the path is configurable.
    const dir = makeLibrary([preset()]);
    expect(resolvePitHouseDir({ home: tmpdir(), env: { MOZA_PITHOUSE_DIR: dir } })).toBe(dir);
  });
});

describe('the .mzpreset container', () => {
  /**
   * Build a real single-entry ZIP, the way Pit House 1.4 writes presets.
   *
   * Hand-rolled rather than mocked: the point of these tests is that we parse
   * the actual container, so a fake would test nothing.
   */
  function mzpreset(json, { method = 8 } = {}) {
    const name = Buffer.from('preset.json', 'utf8');
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    const stored = method === 0 ? body : deflateRawSync(body);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(2, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 14); // crc, unchecked by the reader
    header.writeUInt32LE(stored.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, name, stored]);
  }

  const preset = (id, name) => ({
    id,
    name,
    deviceType: 'Pedals',
    devices: ['mBooster'],
    deviceParams: { brake_forcelimit_max: 24 },
  });

  function seedZipped(entries, { method = 8 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pithouse-mz-'));
    const pedals = join(dir, 'Presets', 'Pedals');
    mkdirSync(pedals, { recursive: true });
    for (const p of entries) {
      writeFileSync(join(pedals, `${p.id}.mzpreset`), mzpreset(p, { method }));
    }
    return dir;
  }

  it('reads a preset out of the zip', () => {
    const dir = seedZipped([preset('a', 'Carter Brake')]);
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Carter Brake']);
    expect(readPreset('a', { dir }).deviceParams.brake_forcelimit_max).toBe(24);
  });

  it('reads a stored entry as well as a deflated one', () => {
    const dir = seedZipped([preset('a', 'Uncompressed')], { method: 0 });
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Uncompressed']);
  });

  it('still reads the pre-upgrade json form', () => {
    // The Backup folder the upgrade left behind is full of these, and a second
    // machine may not have upgraded yet.
    const dir = mkdtempSync(join(tmpdir(), 'pithouse-legacy-'));
    const pedals = join(dir, 'Presets', 'Pedals');
    mkdirSync(pedals, { recursive: true });
    writeFileSync(join(pedals, 'a.json'), JSON.stringify(preset('a', 'Legacy')), 'utf8');
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Legacy']);
    expect(readPreset('a', { dir }).name).toBe('Legacy');
  });

  it('lists a preset once when the upgrade left both forms behind', () => {
    const dir = seedZipped([preset('a', 'Carter Brake')]);
    writeFileSync(
      join(dir, 'Presets', 'Pedals', 'a.json'),
      JSON.stringify(preset('a', 'Carter Brake')),
      'utf8',
    );
    expect(listPresets({ dir })).toHaveLength(1);
  });

  it('prefers the new container when both exist', () => {
    const dir = seedZipped([preset('a', 'From the zip')]);
    writeFileSync(
      join(dir, 'Presets', 'Pedals', 'a.json'),
      JSON.stringify(preset('a', 'From the json')),
      'utf8',
    );
    expect(readPreset('a', { dir }).name).toBe('From the zip');
  });

  it('skips a corrupt archive rather than losing the whole list', () => {
    const dir = seedZipped([preset('a', 'Good')]);
    writeFileSync(join(dir, 'Presets', 'Pedals', 'bad.mzpreset'), Buffer.from('not a zip'));
    expect(listPresets({ dir }).map((p) => p.name)).toEqual(['Good']);
  });
});

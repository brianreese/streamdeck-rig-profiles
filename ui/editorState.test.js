import { describe, it, expect } from 'vitest';
import {
  addProfile, removeProfile, moveProfile, keepSelection,
  matchesSearch, slugify, withIds, fieldValue, optionLabel, holdForNaming,
} from './editorState.js';

const saved = (over = {}) => ({
  id: 'kai', name: 'Kai', color: '#22aa44', restricted: false, providers: {}, ...over,
});

describe('selection identity', () => {
  // The bug this file was extracted for: the editor tracked the profile being
  // edited by id, and an unsaved profile has no id. Two new profiles both
  // answered to "", so editing the second one wrote to the first.
  it('keeps two new profiles apart before either has an id', () => {
    let profiles = [];
    let selected;
    ({ profiles, selected } = addProfile(profiles));
    const first = selected;
    ({ profiles, selected } = addProfile(profiles));
    const second = selected;

    expect(first.id).toBe('');
    expect(second.id).toBe('');
    expect(second).not.toBe(first);

    second.name = 'Carter';
    second.providers.govee = { scene: 'Sunset' };

    expect(first.name).toBe('New profile');
    expect(first.providers).toEqual({});
    expect(profiles.indexOf(second)).toBe(1);
  });

  it('gives those two distinct ids when they are saved', () => {
    let profiles = [];
    ({ profiles } = addProfile(profiles));
    ({ profiles } = addProfile(profiles));
    profiles[1].name = 'Carter';

    withIds(profiles);
    expect(profiles.map((p) => p.id)).toEqual(['new-profile', 'carter']);
  });

  it('re-finds the selection after a reload replaces every object', () => {
    const before = saved();
    const after = [saved({ name: 'Kai renamed elsewhere' }), saved({ id: 'brian', name: 'Brian' })];
    expect(keepSelection(after, before)).toBe(after[0]);
  });

  it('falls back to the first profile when the selected one was deleted', () => {
    const after = [saved({ id: 'brian', name: 'Brian' })];
    expect(keepSelection(after, saved({ id: 'gone' }))).toBe(after[0]);
    expect(keepSelection([], saved())).toBeNull();
  });

  it('does not match an unsaved profile to another unsaved one across a reload', () => {
    // Both have id "", which is exactly the collision that started this.
    const stored = [saved({ id: 'brian', name: 'Brian' })];
    expect(keepSelection(stored, { id: '', name: 'New profile' })).toBe(stored[0]);
  });
});

describe('removeProfile', () => {
  it('removes the object asked for, not the first with a matching id', () => {
    const a = { id: '', name: 'New profile', providers: {} };
    const b = { id: '', name: 'Also new', providers: {} };
    const { profiles, selected } = removeProfile([a, b], b);
    expect(profiles).toEqual([a]);
    expect(selected).toBe(a);
  });

  it('selects nothing when the last profile goes', () => {
    const only = saved();
    expect(removeProfile([only], only).selected).toBeNull();
  });

  it('ignores a look-alike copy — the object is the identity, not its contents', () => {
    const only = saved();
    expect(removeProfile([only], saved()).profiles).toEqual([only]);
  });
});

describe('moveProfile', () => {
  const a = saved({ id: 'a' }), b = saved({ id: 'b' }), c = saved({ id: 'c' });

  it('moves a later profile in front of an earlier one', () => {
    expect(moveProfile([a, b, c], c, a)).toEqual([c, a, b]);
  });

  it('moves an earlier profile after a later one — indices shift, references do not', () => {
    expect(moveProfile([a, b, c], a, c, true)).toEqual([b, c, a]);
  });

  it('leaves the order alone when dropped on itself', () => {
    expect(moveProfile([a, b, c], b, b)).toEqual([a, b, c]);
  });
});

describe('search', () => {
  const p = saved({ name: 'Space Sim', id: 'space-sim', providers: { govee: {} } });

  it('matches on name, id and enabled hardware', () => {
    expect(matchesSearch(p, 'space')).toBe(true);
    expect(matchesSearch(p, 'GOVEE')).toBe(true);
    expect(matchesSearch(p, 'wheelbase')).toBe(false);
  });

  it('matches everything when the box is empty', () => {
    expect(matchesSearch(p, '  ')).toBe(true);
  });
});

describe('slugify', () => {
  it('makes a readable id from the name', () => {
    expect(slugify('Space Sim', [])).toBe('space-sim');
  });

  it('never collides with an id already taken', () => {
    expect(slugify('Kai', ['kai', 'kai-2'])).toBe('kai-3');
  });

  it('falls back rather than producing an empty id', () => {
    expect(slugify('!!!', [])).toBe('profile');
  });
});

describe('optionLabel', () => {
  it('names a wheelbase slot the way the Fanatec app does', () => {
    expect(optionLabel('S1')).toBe('Setup 1');
    expect(optionLabel('S5')).toBe('Setup 5');
  });

  it('drops the values read off the base but keeps which slot is live', () => {
    expect(optionLabel('S3 — FFB 60, FUL 100, FEI 100 (current)')).toBe('Setup 3 (current)');
    expect(optionLabel('S2 — FFB 45')).toBe('Setup 2');
    expect(optionLabel('S4 (current)')).toBe('Setup 4 (current)');
  });

  it('leaves the options of every other provider exactly as they are', () => {
    // A Govee scene or a MOZA preset that happens to start with an S is not a
    // slot, and renaming someone's preset would be worse than the noise.
    expect(optionLabel('S1 Sunset')).toBe('S1 Sunset');
    expect(optionLabel('Sunset')).toBe('Sunset');
    expect(optionLabel("Kai's brake curve")).toBe("Kai's brake curve");
    expect(optionLabel('')).toBe('');
  });
});

describe('holdForNaming', () => {
  const unsaved = { id: '', name: 'New profile' };
  const stored = { id: 'kai', name: 'Kai' };

  it('holds the autosave while a brand-new profile is being named', () => {
    // Saving here would slug "Ka" into a permanent id for a profile called Kai.
    expect(holdForNaming([stored, unsaved], 'name')).toBe(true);
  });

  it('does not hold for anything but the name field', () => {
    expect(holdForNaming([unsaved], 'color')).toBe(false);
    expect(holdForNaming([unsaved], undefined)).toBe(false);
  });

  it('does not hold when every profile already has its permanent id', () => {
    // Renaming a saved profile leaves the id alone, so there is nothing to wait
    // for and no reason to make the user click away.
    expect(holdForNaming([stored], 'name')).toBe(false);
    expect(holdForNaming([], 'name')).toBe(false);
    expect(holdForNaming(undefined, 'name')).toBe(false);
  });
});

describe('fieldValue', () => {
  it('stores numbers as numbers, including tenths', () => {
    expect(fieldValue('42')).toBe(42);
    expect(fieldValue('12.5')).toBe(12.5);
  });

  it('leaves a MOZA preset uuid as text', () => {
    const uuid = 'c903ac57-6ef3-4d73-bd45-710382319609';
    expect(fieldValue(uuid)).toBe(uuid);
  });

  it('clears the key when the field is emptied', () => {
    expect(fieldValue('')).toBeUndefined();
  });

  it('keeps false, which is a value and not an empty field', () => {
    expect(fieldValue(false)).toBe(false);
  });
});

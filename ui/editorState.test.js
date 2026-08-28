import { describe, it, expect } from 'vitest';
import {
  addProfile, addScene, newScene, removeProfile, moveProfile, keepSelection,
  matchesSearch, slugify, withIds, fieldValue, optionLabel, holdForNaming,
  sceneRefs, referencesScene, setSceneRef, profilesUsingScene, detachScene, sceneOverlap,
} from './editorState.js';

const saved = (over = {}) => ({
  id: 'kai', name: 'Kai', color: '#22aa44', restricted: false, providers: {}, ...over,
});

const scene = (over = {}) => ({
  id: 'sunset', name: 'Sunset', color: '#7c5cff', providers: {}, ...over,
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

describe('newScene', () => {
  it('has no restricted flag at all — not even a false one', () => {
    // A scene cannot hand anyone full force feedback, so a hold gate in front
    // of it would be a gate in front of nothing. Storing `restricted: false`
    // would still put the word in the record and invite the next reader to
    // wonder what a gated scene is.
    expect('restricted' in newScene()).toBe(false);
  });

  it('is otherwise exactly the shape a profile is', () => {
    expect(Object.keys(newScene()).sort()).toEqual(['color', 'id', 'name', 'providers']);
  });

  it('appends to the scene list and selects the new one', () => {
    const { scenes, selected } = addScene([scene()]);
    expect(scenes).toHaveLength(2);
    expect(selected).toBe(scenes[1]);
  });
});

describe('slugify and withIds across the two lists', () => {
  it('falls back to "scene" rather than "profile" for an unnameable scene', () => {
    expect(slugify('!!!', [], 'scene')).toBe('scene');
  });

  it('slugs the two lists independently, so a name may exist in both', () => {
    // Separate lists and separate lookups: a profile only ever names a scene
    // from the scene list, so `brian` being both is never ambiguous.
    const ps = [{ id: '', name: 'Brian', providers: {} }];
    const ss = [{ id: '', name: 'Brian', providers: {} }];
    withIds(ps);
    withIds(ss, 'scene');
    expect(ps[0].id).toBe('brian');
    expect(ss[0].id).toBe('brian');
  });
});

describe('scene references', () => {
  it('reports no references for a profile written before scenes existed', () => {
    expect(sceneRefs(saved())).toEqual([]);
    expect(referencesScene(saved(), 'sunset')).toBe(false);
  });

  it('adds and removes one reference', () => {
    const p = saved();
    setSceneRef(p, 'sunset', true);
    expect(p.scenes).toEqual(['sunset']);
    expect(referencesScene(p, 'sunset')).toBe(true);
    setSceneRef(p, 'sunset', false);
    expect(referencesScene(p, 'sunset')).toBe(false);
  });

  it('deletes the key rather than leaving an empty array behind', () => {
    // So a profile referencing nothing looks in storage exactly like one
    // written before scenes were a thing.
    const p = saved({ scenes: ['sunset'] });
    setSceneRef(p, 'sunset', false);
    expect('scenes' in p).toBe(false);
  });

  it('never stores the same scene twice', () => {
    const p = saved({ scenes: ['sunset'] });
    setSceneRef(p, 'sunset', true);
    expect(p.scenes).toEqual(['sunset']);
  });

  it('finds every profile that runs a scene', () => {
    const a = saved({ id: 'a', scenes: ['sunset'] });
    const b = saved({ id: 'b' });
    const c = saved({ id: 'c', scenes: ['dusk', 'sunset'] });
    expect(profilesUsingScene([a, b, c], 'sunset')).toEqual([a, c]);
    expect(profilesUsingScene([a, b, c], 'nobody')).toEqual([]);
  });
});

describe('detachScene', () => {
  it('removes a deleted scene from every profile that referenced it', () => {
    // The whole point: deleting a scene must not leave a profile claiming to
    // run something that no longer exists, which the runtime would skip with a
    // log line nobody reads while the lights quietly stayed off.
    const a = saved({ id: 'a', scenes: ['sunset', 'dusk'] });
    const b = saved({ id: 'b', scenes: ['dusk'] });
    const c = saved({ id: 'c', scenes: ['sunset'] });

    expect(detachScene([a, b, c], 'sunset')).toEqual([a, c]);
    expect(a.scenes).toEqual(['dusk']);
    expect(b.scenes).toEqual(['dusk']);   // untouched
    expect('scenes' in c).toBe(false);    // its only reference is gone
  });

  it('reports nothing changed when no profile referenced it', () => {
    expect(detachScene([saved()], 'sunset')).toEqual([]);
  });
});

describe('sceneOverlap', () => {
  it('names the providers a profile already sets itself', () => {
    // The runtime keeps the profile's setting and skips the scene's, which is
    // right and completely invisible — so the editor has to say it.
    const p = saved({ providers: { govee: { scene: 'Race' }, apps: {} } });
    const s = scene({ providers: { govee: { scene: 'Sunset' }, moza: {} } });
    expect(sceneOverlap(p, s)).toEqual(['govee']);
  });

  it('is empty when the scene only fills in gaps', () => {
    const p = saved({ providers: { 'fanatec-base': { setup: 2 } } });
    expect(sceneOverlap(p, scene({ providers: { govee: {} } }))).toEqual([]);
  });
});

describe('holdForNaming across both lists', () => {
  it('holds for an unsaved scene too — a scene id is slugged the same way', () => {
    const stored = { id: 'kai', name: 'Kai' };
    const unsavedScene = { id: '', name: 'New scene' };
    expect(holdForNaming([stored, unsavedScene], 'name')).toBe(true);
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

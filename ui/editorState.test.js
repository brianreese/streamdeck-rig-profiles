import { describe, it, expect } from 'vitest';
import {
  addProfile, addMode, newMode, removeProfile, moveProfile, keepSelection,
  matchesSearch, slugify, withIds, fieldValue, optionLabel, holdForNaming,
  modeRefs, referencesMode, setModeRef, profilesUsingMode, detachMode, modeOverlap,
  reportsState, modeStatefulness,
  offers, providerContexts, unknownSelectValue, unknownValues, blocksEditing,
  isBlank, blankBlocks, configuredBlocks, withoutBlankBlocks, forStorage,
  providerIdOf, instanceOf, instanceKeys, nextInstanceKey, isRepeatable, blockSummary,
} from './editorState.js';

const saved = (over = {}) => ({
  id: 'kai', name: 'Kai', color: '#22aa44', restricted: false, providers: {}, ...over,
});

const mode = (over = {}) => ({
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

describe('newMode', () => {
  it('has no restricted flag at all — not even a false one', () => {
    // A mode cannot hand anyone full force feedback, so a hold gate in front
    // of it would be a gate in front of nothing. Storing `restricted: false`
    // would still put the word in the record and invite the next reader to
    // wonder what a gated mode is.
    expect('restricted' in newMode()).toBe(false);
  });

  it('is otherwise exactly the shape a profile is', () => {
    expect(Object.keys(newMode()).sort()).toEqual(['color', 'id', 'name', 'providers']);
  });

  it('appends to the mode list and selects the new one', () => {
    const { modes, selected } = addMode([mode()]);
    expect(modes).toHaveLength(2);
    expect(selected).toBe(modes[1]);
  });
});

describe('slugify and withIds across the two lists', () => {
  it('falls back to "mode" rather than "profile" for an unnameable mode', () => {
    expect(slugify('!!!', [], 'mode')).toBe('mode');
  });

  it('slugs the two lists independently, so a name may exist in both', () => {
    // Separate lists and separate lookups: a profile only ever names a mode
    // from the mode list, so `brian` being both is never ambiguous.
    const ps = [{ id: '', name: 'Brian', providers: {} }];
    const ss = [{ id: '', name: 'Brian', providers: {} }];
    withIds(ps);
    withIds(ss, 'mode');
    expect(ps[0].id).toBe('brian');
    expect(ss[0].id).toBe('brian');
  });
});

describe('mode references', () => {
  it('reports no references for a profile written before modes existed', () => {
    expect(modeRefs(saved())).toEqual([]);
    expect(referencesMode(saved(), 'sunset')).toBe(false);
  });

  it('adds and removes one reference', () => {
    const p = saved();
    setModeRef(p, 'sunset', true);
    expect(p.modes).toEqual(['sunset']);
    expect(referencesMode(p, 'sunset')).toBe(true);
    setModeRef(p, 'sunset', false);
    expect(referencesMode(p, 'sunset')).toBe(false);
  });

  it('deletes the key rather than leaving an empty array behind', () => {
    // So a profile referencing nothing looks in storage exactly like one
    // written before modes were a thing.
    const p = saved({ modes: ['sunset'] });
    setModeRef(p, 'sunset', false);
    expect('modes' in p).toBe(false);
  });

  it('never stores the same mode twice', () => {
    const p = saved({ modes: ['sunset'] });
    setModeRef(p, 'sunset', true);
    expect(p.modes).toEqual(['sunset']);
  });

  it('finds every profile that runs a mode', () => {
    const a = saved({ id: 'a', modes: ['sunset'] });
    const b = saved({ id: 'b' });
    const c = saved({ id: 'c', modes: ['dusk', 'sunset'] });
    expect(profilesUsingMode([a, b, c], 'sunset')).toEqual([a, c]);
    expect(profilesUsingMode([a, b, c], 'nobody')).toEqual([]);
  });
});

describe('detachMode', () => {
  it('removes a deleted mode from every profile that referenced it', () => {
    // The whole point: deleting a mode must not leave a profile claiming to
    // run something that no longer exists, which the runtime would skip with a
    // log line nobody reads while the lights quietly stayed off.
    const a = saved({ id: 'a', modes: ['sunset', 'dusk'] });
    const b = saved({ id: 'b', modes: ['dusk'] });
    const c = saved({ id: 'c', modes: ['sunset'] });

    expect(detachMode([a, b, c], 'sunset')).toEqual([a, c]);
    expect(a.modes).toEqual(['dusk']);
    expect(b.modes).toEqual(['dusk']);   // untouched
    expect('modes' in c).toBe(false);    // its only reference is gone
  });

  it('reports nothing changed when no profile referenced it', () => {
    expect(detachMode([saved()], 'sunset')).toEqual([]);
  });
});

describe('modeOverlap', () => {
  it('names the providers a profile already sets itself', () => {
    // The runtime keeps the profile's setting and skips the mode's, which is
    // right and completely invisible — so the editor has to say it.
    const p = saved({ providers: { govee: { scene: 'Race' }, apps: {} } });
    const s = mode({ providers: { govee: { scene: 'Sunset' }, moza: {} } });
    expect(modeOverlap(p, s)).toEqual(['govee']);
  });

  it('is empty when the mode only fills in gaps', () => {
    const p = saved({ providers: { 'fanatec-base': { setup: 2 } } });
    expect(modeOverlap(p, mode({ providers: { govee: {} } }))).toEqual([]);
  });
});

describe('holdForNaming across both lists', () => {
  it('holds for an unsaved mode too — a mode id is slugged the same way', () => {
    const stored = { id: 'kai', name: 'Kai' };
    const unsavedMode = { id: '', name: 'New mode' };
    expect(holdForNaming([stored, unsavedMode], 'name')).toBe(true);
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

// ---------------------------------------------------------------------------
// The third column
// ---------------------------------------------------------------------------

const wheelbase = { id: 'fanatec-base', label: 'Fanatec Wheelbase', contexts: ['profile'] };
const lights = { id: 'govee', label: 'Govee Lighting', contexts: ['profile', 'mode'] };
const apps = { id: 'apps', label: 'Apps & Scripts', contexts: ['profile', 'mode'] };
// The one that can answer "am I in effect?". Note it declares the same contexts
// Govee does — being usable in a Mode and being able to report yourself are
// different capabilities, and the pair below is what keeps that honest.
// It is also the only repeatable one: a Mode routinely asserts more than one
// fact and they may point in different directions — `vr` on AND `assists` off —
// which one block cannot say, because the invert belongs to the block.
const flag = {
  id: 'state-flag', label: 'Rig State Flag', contexts: ['profile', 'mode'], reportsState: true,
  repeatable: true,
  fields: [
    { key: 'flag', label: 'Flag', type: 'text' },
    { key: 'whenOff', label: 'Active when off', type: 'boolean' },
  ],
};
const kit = [wheelbase, lights, apps];

describe('providerContexts', () => {
  it('takes the provider at its word', () => {
    expect(providerContexts(lights)).toEqual(['profile', 'mode']);
  });

  // A provider that declares nothing is profile-only. The failure worth
  // defaulting away from is a mode quietly reaching hardware nobody meant it
  // to touch — a missing row in a list is a far cheaper mistake.
  it('treats a provider that declares nothing as profile-only', () => {
    expect(providerContexts({ id: 'mystery' })).toEqual(['profile']);
    expect(providerContexts({ id: 'mystery', contexts: [] })).toEqual(['profile']);
  });
});

// ---------------------------------------------------------------------------
// Whether a Mode's key will have an on/off state
//
// The merge of Scenes and Modes turned one action into two behaviours, and this
// is what keeps that from being confusing: the difference is derived from the
// providers inside, never declared, and the editor says which one you have got.
// ---------------------------------------------------------------------------

describe('reportsState', () => {
  it('believes only an explicit true', () => {
    expect(reportsState(flag)).toBe(true);
    expect(reportsState(lights)).toBe(false);
    expect(reportsState({ id: 'x' })).toBe(false);
    expect(reportsState(undefined)).toBe(false);
  });
});

describe('modeStatefulness', () => {
  const all = [...kit, flag];

  // The whole rule in one test: the Mode asserts nothing, its contents decide.
  it('is stateful when one provider inside can report itself', () => {
    const m = mode({ providers: { 'state-flag': { flag: 'display', value: 'vr' } } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: true, reporters: ['Rig State Flag'], quiet: [],
    });
  });

  it('is not stateful when nothing inside can, however much is in it', () => {
    const m = mode({ providers: { govee: { scene: 'Sunset' }, apps: { commands: 'x' } } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: false, reporters: [], quiet: ['Govee Lighting', 'Apps & Scripts'],
    });
  });

  // The user's actual case: one flag, some lights, a throwaway script, one key.
  // Mixing is the point — the providers that cannot answer neither add to the
  // verdict nor spoil it.
  it('mixes freely, and only the ones that answer count', () => {
    const m = mode({
      providers: {
        'state-flag': { flag: 'display', value: 'vr' },
        govee: { scene: 'Sunset' },
        apps: { commands: 'start vr.exe' },
      },
    });
    const { stateful, reporters, quiet } = modeStatefulness(m, all);
    expect(stateful).toBe(true);
    expect(reporters).toEqual(['Rig State Flag']);
    expect(quiet).toEqual(['Govee Lighting', 'Apps & Scripts']);
  });

  // Being allowed in a Mode is not a promise to report state. If these two ever
  // got conflated, Govee and Apps could not be in a Mode at all.
  it('does not treat the mode context as a promise to report state', () => {
    expect(providerContexts(lights)).toContain('mode');
    expect(reportsState(lights)).toBe(false);
    expect(modeStatefulness(mode({ providers: { govee: { scene: 'S' } } }), all).stateful).toBe(false);
  });

  // A blank block is not stored, so it does not run, so it cannot report
  // anything. Same rule modeOverlap follows, for the same reason: describe the
  // Mode that will be saved, not the draft on screen.
  it('does not let a blank block make a Mode stateful', () => {
    const m = mode({ providers: { 'state-flag': {} } });
    expect(modeStatefulness(m, all).stateful).toBe(false);
  });

  // But it is called out rather than ignored. Adding the one provider that
  // would make the key stateful and seeing nothing change would read as a bug.
  it('names a state-reporting block that has not been filled in yet', () => {
    const m = mode({ providers: { 'state-flag': {}, govee: { scene: 'Sunset' } } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: false, reporters: [], quiet: ['Govee Lighting'], pending: ['Rig State Flag'],
    });
  });

  it('does not list a blank block that could never report anything as pending', () => {
    expect(modeStatefulness(mode({ providers: { govee: {} } }), all).pending).toEqual([]);
  });

  it('falls back to the id when the provider list has no label for it', () => {
    // Config outlives code: a provider id this build does not know must not
    // crash the pane, and must not silently claim to report state either.
    const m = mode({ providers: { 'warp-drive': { coils: 3 } } });
    expect(modeStatefulness(m, all)).toMatchObject({ stateful: false, quiet: ['warp-drive'] });
  });

  it('survives an empty Mode and no provider list at all', () => {
    expect(modeStatefulness(newMode(), all)).toEqual({
      stateful: false, reporters: [], quiet: [], pending: [],
    });
    expect(modeStatefulness(undefined).stateful).toBe(false);
  });

  // The instance case. A suffixed key names the same provider, so it reports
  // state for the same reason the first one does — resolving the key as though
  // it were the id would find no provider and quietly drop the Mode's state.
  it('resolves a suffixed key back to its provider', () => {
    const m = mode({ providers: { 'state-flag#2': { flag: 'assists', whenOff: true } } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: true, reporters: ['Rig State Flag'],
    });
  });

  // Two blocks, one name. "Rig State Flag, Rig State Flag can report whether
  // they are currently in effect" is not a sentence anyone should read.
  it('names a provider once however many instances of it there are', () => {
    const m = mode({
      providers: {
        'state-flag': { flag: 'vr' },
        'state-flag#2': { flag: 'assists', whenOff: true },
        govee: { scene: 'Sunset' },
      },
    });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: true, reporters: ['Rig State Flag'], quiet: ['Govee Lighting'], pending: [],
    });
  });

  // One finished flag and one still empty. The key already HAS its on/off, so
  // being told to finish something before it gains one would be wrong — the
  // empty block is still not saved, which `renderIssues` says separately.
  it('does not call a provider pending when another instance of it is finished', () => {
    const m = mode({ providers: { 'state-flag': { flag: 'vr' }, 'state-flag#2': {} } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: true, reporters: ['Rig State Flag'], pending: [],
    });
  });

  it('still calls it pending when every instance of it is empty', () => {
    const m = mode({ providers: { 'state-flag': {}, 'state-flag#2': {} } });
    expect(modeStatefulness(m, all)).toMatchObject({
      stateful: false, reporters: [], pending: ['Rig State Flag'],
    });
  });
});

// ---------------------------------------------------------------------------
// Provider instances
//
// The same provider, twice, on one record. Everything here turns on the
// distinction between a config KEY and a provider ID, which are equal for every
// provider that is not repeatable and for the first instance of one that is —
// which is exactly why confusing them is easy and why it has to be tested.
// ---------------------------------------------------------------------------

describe('providerIdOf / instanceOf', () => {
  it('splits a key into the provider it names and the suffix that keeps it distinct', () => {
    expect(providerIdOf('state-flag#2')).toBe('state-flag');
    expect(instanceOf('state-flag#2')).toBe('2');
  });

  it('leaves an unsuffixed key exactly as it is', () => {
    expect(providerIdOf('govee')).toBe('govee');
    expect(instanceOf('govee')).toBe('');
  });

  // Must agree with src/providers/index.js, which reads the same stored keys
  // from the other side of the wire. First `#` wins there too.
  it('splits on the first hash, so a suffix containing one still resolves', () => {
    expect(providerIdOf('state-flag#a#b')).toBe('state-flag');
    expect(instanceOf('state-flag#a#b')).toBe('a#b');
  });

  it('survives a missing key rather than throwing inside a render', () => {
    expect(providerIdOf(undefined)).toBe('');
    expect(instanceOf(null)).toBe('');
  });
});

describe('instanceKeys', () => {
  it('finds every block belonging to one provider, in stored order', () => {
    const m = mode({
      providers: { 'state-flag': { flag: 'vr' }, govee: {}, 'state-flag#2': { flag: 'a' } },
    });
    expect(instanceKeys(m, 'state-flag')).toEqual(['state-flag', 'state-flag#2']);
    expect(instanceKeys(m, 'govee')).toEqual(['govee']);
  });

  // The bug this guards: a bare-id lookup on a record whose only instance was
  // stored under a suffix reports it as holding none, and the editor offers to
  // add a first one that is already there.
  it('finds an instance that is not the first, on its own', () => {
    expect(instanceKeys(mode({ providers: { 'state-flag#3': {} } }), 'state-flag'))
      .toEqual(['state-flag#3']);
  });

  it('does not confuse one provider for another that starts the same way', () => {
    expect(instanceKeys(mode({ providers: { 'state-flagged': {} } }), 'state-flag')).toEqual([]);
  });

  it('survives a record with no providers map', () => {
    expect(instanceKeys(undefined, 'govee')).toEqual([]);
  });
});

describe('nextInstanceKey', () => {
  // The first one is the bare id, so a record holding one of something looks in
  // storage exactly as it did before instances existed. Nothing to migrate.
  it('gives the first instance the bare provider id', () => {
    expect(nextInstanceKey(mode(), 'state-flag')).toBe('state-flag');
  });

  it('numbers the ones after it', () => {
    const m = mode({ providers: { 'state-flag': { flag: 'vr' } } });
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag#2');
    m.providers['state-flag#2'] = { flag: 'assists' };
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag#3');
  });

  // The stability rule. A key is what the stored config hangs on, so removing
  // one instance must not move another: `#3` stays `#3` for as long as it
  // exists, and only a NEW block takes the gap that opened at `#2`.
  it('never renumbers what is already there when one is removed', () => {
    const m = mode({
      providers: {
        'state-flag': { flag: 'vr' },
        'state-flag#2': { flag: 'assists' },
        'state-flag#3': { flag: 'motion' },
      },
    });
    delete m.providers['state-flag#2'];
    expect(Object.keys(m.providers)).toEqual(['state-flag', 'state-flag#3']);
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag#2');
    expect(m.providers['state-flag#3']).toEqual({ flag: 'motion' });
  });

  it('never collides with a key already on the record, whoever wrote it', () => {
    const m = mode({ providers: { 'state-flag#2': {}, 'state-flag#3': {} } });
    // The bare id is free, so it is what a fresh block gets — the gap at the
    // front is a gap like any other.
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag');
    m.providers['state-flag'] = {};
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag#4');
  });

  it('is unaffected by other providers on the record', () => {
    const m = mode({ providers: { govee: {}, 'govee#2': {} } });
    expect(nextInstanceKey(m, 'state-flag')).toBe('state-flag');
  });
});

describe('isRepeatable', () => {
  it('believes only an explicit true, like every other capability here', () => {
    expect(isRepeatable(flag)).toBe(true);
    expect(isRepeatable(lights)).toBe(false);
    expect(isRepeatable(undefined)).toBe(false);
  });
});

describe('blockSummary', () => {
  // The failure this exists to prevent: two blocks headed "Rig State Flag" and
  // nothing else to tell them apart.
  it('says what the block is set to, so two of them read differently', () => {
    expect(blockSummary(flag, { flag: 'vr' })).toBe('vr');
    expect(blockSummary(flag, { flag: 'assists', whenOff: true }))
      .toBe('assists · active when off');
  });

  it('names a boolean by its label and only when it is on', () => {
    expect(blockSummary(flag, { flag: 'vr', whenOff: false })).toBe('vr');
  });

  it('says nothing about a block that holds nothing — it has its own wording', () => {
    expect(blockSummary(flag, {})).toBe('');
    expect(blockSummary(flag, undefined)).toBe('');
  });

  // Config outlives code: a value whose field the schema no longer declares
  // still means the block holds something, and an empty subtitle there would
  // look like the summary had failed rather than like the schema had moved.
  it('falls back to the stored keys when the schema explains none of them', () => {
    expect(blockSummary({ id: 'x', fields: [] }, { legacy: 1, other: 2 })).toBe('legacy, other');
  });
});

describe('offers', () => {
  it('offers every provider on a profile, with modes after them', () => {
    const list = offers({
      providers: kit,
      modes: [mode()],
      record: saved(),
      kind: 'profiles',
    });
    expect(list.map((o) => `${o.type}:${o.id}`)).toEqual([
      'provider:fanatec-base', 'provider:govee', 'provider:apps', 'mode:sunset',
    ]);
  });

  // The rule this whole function exists for: a mode is a moment of ambience
  // and must never be able to hand a child full force feedback, so the hardware
  // that could is not offered on one at all.
  it('offers a mode only the providers that declare the mode context', () => {
    const list = offers({ providers: kit, record: newMode(), kind: 'modes' });
    expect(list.map((o) => o.id)).toEqual(['govee', 'apps']);
  });

  it('never offers a mode on another mode', () => {
    const list = offers({
      providers: kit,
      modes: [mode(), mode({ id: 'dusk', name: 'Dusk' })],
      record: newMode(),
      kind: 'modes',
    });
    expect(list.some((o) => o.type === 'mode')).toBe(false);
  });

  // Greyed out, not gone: a row that vanishes when used leaves the user
  // wondering whether they imagined it, and the list shuffles under the cursor.
  it('keeps an added provider in the list and marks it added', () => {
    const list = offers({
      providers: kit,
      record: saved({ providers: { govee: { scene: 'Sunset' } } }),
    });
    expect(list.find((o) => o.id === 'govee').added).toBe(true);
    expect(list.find((o) => o.id === 'apps').added).toBe(false);
  });

  it('marks a mode the profile already runs as added', () => {
    const list = offers({
      providers: kit,
      modes: [mode(), mode({ id: 'dusk', name: 'Dusk' })],
      record: saved({ modes: ['sunset'] }),
    });
    expect(list.find((o) => o.id === 'sunset').added).toBe(true);
    expect(list.find((o) => o.id === 'dusk').added).toBe(false);
  });

  // An id is what a profile stores, so a mode without one cannot be picked
  // yet. It gets one within the second, on its own first save.
  it('does not offer a mode that has never been saved', () => {
    const list = offers({ providers: [], modes: [newMode()], record: saved() });
    expect(list).toEqual([]);
  });

  it('searches providers and modes together, in one query', () => {
    const list = offers({
      providers: kit,
      modes: [mode({ id: 'apps-off', name: 'Everything off' })],
      record: saved(),
      query: 'app',
    });
    expect(list.map((o) => `${o.type}:${o.id}`)).toEqual(['provider:apps', 'mode:apps-off']);
  });

  it('finds a mode by the hardware it sets, not only by its name', () => {
    const list = offers({
      providers: [],
      modes: [mode({ providers: { govee: { scene: 'Sunset' } } })],
      record: saved(),
      query: 'govee',
    });
    expect(list.map((o) => o.id)).toEqual(['sunset']);
  });

  it('survives a record with no providers map and no selection at all', () => {
    expect(offers({ providers: kit, record: null }).every((o) => o.added === false)).toBe(true);
    expect(offers()).toEqual([]);
  });

  // A Mode asserting `vr` on and `assists` off needs the row to still work
  // after the first one. Greying it out would make the second flag unreachable.
  it('keeps a repeatable provider addable however many are already on the record', () => {
    const m = mode({
      providers: { 'state-flag': { flag: 'vr' }, 'state-flag#2': { flag: 'assists' } },
    });
    const row = offers({ providers: [...kit, flag], record: m, kind: 'modes' })
      .find((o) => o.id === 'state-flag');
    expect(row).toMatchObject({ added: false, repeatable: true, count: 2 });
  });

  it('still counts a repeatable provider that has never been added', () => {
    const row = offers({ providers: [flag], record: newMode(), kind: 'modes' })[0];
    expect(row).toMatchObject({ added: false, count: 0 });
  });

  // The rule that has not changed, and the one that stops a wheelbase being
  // configured twice with two different setup slots.
  it('still greys out a provider that did not ask to be repeatable', () => {
    const list = offers({
      providers: [...kit, flag],
      record: saved({ providers: { govee: { scene: 'Sunset' }, 'state-flag': { flag: 'vr' } } }),
    });
    expect(list.find((o) => o.id === 'govee')).toMatchObject({ added: true, count: 1 });
    expect(list.find((o) => o.id === 'state-flag').added).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stored values whose option has gone away
// ---------------------------------------------------------------------------

const presetField = (over = {}) => ({
  key: 'preset', label: 'Pit House preset', type: 'select',
  options: [{ value: 'aaa', label: 'Kai soft' }, { value: 'bbb', label: 'Race' }],
  optionsLive: true, ...over,
});

describe('unknownSelectValue', () => {
  it('says nothing about a value that is in the list', () => {
    expect(unknownSelectValue(presetField(), 'aaa')).toBeNull();
  });

  it('says nothing about an empty value — that is "not set", not "missing"', () => {
    expect(unknownSelectValue(presetField(), '')).toBeNull();
    expect(unknownSelectValue(presetField(), undefined)).toBeNull();
    expect(unknownSelectValue(presetField(), null)).toBeNull();
  });

  it('ignores fields that are not selects', () => {
    expect(unknownSelectValue({ key: 'peakForceKg', type: 'range' }, 42)).toBeNull();
    expect(unknownSelectValue({ key: 'commands', type: 'textarea' }, 'x')).toBeNull();
  });

  // The case the whole thing exists for: Pit House repackaged its presets and
  // the stored uuid names something that is no longer offered.
  it('reports a value the list does not contain as missing', () => {
    expect(unknownSelectValue(presetField(), 'c903ac57')).toEqual({
      key: 'preset', label: 'Pit House preset', value: 'c903ac57', why: 'missing',
    });
  });

  // No options came back at all. That is what a closed Pit House or an
  // unreachable wheelbase looks like, and it says nothing about the value.
  it('reports a value as unverifiable when no options came back', () => {
    const field = presetField({ options: [], optionsLive: false });
    expect(unknownSelectValue(field, 'c903ac57').why).toBe('unverifiable');
  });

  it('treats an absent options list the same as an empty one', () => {
    const field = presetField({ options: undefined, optionsLive: false });
    expect(unknownSelectValue(field, 'c903ac57').why).toBe('unverifiable');
  });

  // A provider with no options() of its own declares its whole domain in the
  // schema, so an empty list there really does mean "nothing matches".
  it('trusts an empty list when the provider says it is authoritative', () => {
    const field = presetField({ options: [], optionsLive: true });
    expect(unknownSelectValue(field, 'c903ac57').why).toBe('missing');
  });

  // A wheelbase slot is stored as a number and offered as one, but the two
  // sides have crossed the wire as strings before now. Reporting Setup 2 as
  // missing because 2 !== "2" would lock a block for no reason at all.
  it('matches across the string/number boundary', () => {
    const slots = { key: 'setup', type: 'select', optionsLive: true,
      options: [{ value: 1, label: 'Setup 1' }, { value: 2, label: 'Setup 2' }] };
    expect(unknownSelectValue(slots, '2')).toBeNull();
    expect(unknownSelectValue({ ...slots, options: [{ value: '2', label: 'Setup 2' }] }, 2)).toBeNull();
  });
});

describe('unknownValues', () => {
  const moza = {
    id: 'moza',
    fields: [presetField(), { key: 'peakForceKg', label: 'Peak force', type: 'range' }],
  };

  it('finds nothing wrong with a config whose preset still exists', () => {
    expect(unknownValues(moza, { preset: 'aaa', peakForceKg: 12 })).toEqual([]);
  });

  it('picks out only the select whose value has gone', () => {
    const found = unknownValues(moza, { preset: 'gone-uuid', peakForceKg: 12 });
    expect(found.map((u) => u.key)).toEqual(['preset']);
    expect(found[0].value).toBe('gone-uuid');
  });

  // Provider-agnostic by construction: a Govee mode renamed in the Govee app
  // is the same shape of problem and gets the same answer.
  it('works the same for a renamed Govee scene', () => {
    const govee = { id: 'govee', fields: [{ key: 'scene', label: 'Scene', type: 'select',
      options: [{ value: 'Sunset', label: 'Sunset' }], optionsLive: true }] };
    expect(unknownValues(govee, { scene: 'Sunrise' })[0].why).toBe('missing');
    expect(unknownValues(govee, { scene: 'Sunset' })).toEqual([]);
  });

  it('survives a provider with no fields and a config with nothing in it', () => {
    expect(unknownValues({ id: 'x' }, {})).toEqual([]);
    expect(unknownValues(undefined, undefined)).toEqual([]);
  });
});

describe('blocksEditing', () => {
  it('locks the block for a value that is known to be gone', () => {
    expect(blocksEditing([{ why: 'missing' }])).toBe(true);
  });

  // Crying wolf is the failure here. Pit House is closed most of the time; the
  // pedal forces on a profile must not grey out every time it is.
  it('leaves the block alone when the value merely could not be checked', () => {
    expect(blocksEditing([{ why: 'unverifiable' }])).toBe(false);
  });

  it('locks when a missing value sits beside an unverifiable one', () => {
    expect(blocksEditing([{ why: 'unverifiable' }, { why: 'missing' }])).toBe(true);
  });

  it('leaves an untroubled block alone', () => {
    expect(blocksEditing([])).toBe(false);
    expect(blocksEditing(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blocks that hold nothing yet
//
// The bug: adding a provider creates `providers.moza = {}`, autosave fires half
// a second later, and MOZA correctly reports that no preset is chosen — so the
// user is told off for a state they had had no chance to leave. An empty block
// is incomplete, not invalid, and incomplete configuration is not stored.
// ---------------------------------------------------------------------------

describe('isBlank', () => {
  it('is what a provider looks like the instant it is added', () => {
    expect(isBlank({})).toBe(true);
  });

  it('is not blank once anything at all has been chosen', () => {
    expect(isBlank({ preset: 'aaa' })).toBe(false);
    // Including a value the provider will go on to reject: "wrong" is a
    // different state from "empty", and only the empty one is withheld.
    expect(isBlank({ peakForceKg: 2 })).toBe(false);
    // And including a falsy one. An unticked boolean is a decision.
    expect(isBlank({ wait: false })).toBe(false);
  });

  it('treats a missing block as blank rather than throwing', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank(null)).toBe(true);
  });
});

describe('blankBlocks / configuredBlocks', () => {
  const mixed = saved({ providers: { moza: {}, govee: { scene: 'Sunset' }, apps: {} } });

  it('separates the blocks that say something from the ones that do not', () => {
    expect(blankBlocks(mixed)).toEqual(['moza', 'apps']);
    expect(configuredBlocks(mixed)).toEqual(['govee']);
  });

  it('copes with a record that has no providers map at all', () => {
    expect(blankBlocks({})).toEqual([]);
    expect(configuredBlocks(undefined)).toEqual([]);
  });
});

describe('withoutBlankBlocks', () => {
  it('leaves an empty block out of what gets stored', () => {
    const p = saved({ providers: { moza: {}, govee: { scene: 'Sunset' } } });
    expect(withoutBlankBlocks(p).providers).toEqual({ govee: { scene: 'Sunset' } });
  });

  // The editor keeps showing these same objects. Deleting the block in place
  // would make it vanish from the screen the moment it autosaved, and the user
  // would watch the thing they just added disappear.
  it('never touches the draft the editor is still showing', () => {
    const p = saved({ providers: { moza: {} } });
    withoutBlankBlocks(p);
    expect(p.providers).toEqual({ moza: {} });
  });

  it('hands back the record itself when there is nothing to leave out', () => {
    const p = saved({ providers: { govee: { scene: 'Sunset' } } });
    expect(withoutBlankBlocks(p)).toBe(p);
  });

  it('keeps everything else about the record', () => {
    const p = saved({ providers: { moza: {} }, modes: ['sunset'], restricted: true });
    const out = withoutBlankBlocks(p);
    expect(out.id).toBe('kai');
    expect(out.modes).toEqual(['sunset']);
    expect(out.restricted).toBe(true);
  });
});

describe('forStorage', () => {
  // Modes and profiles save in one request, so one blank block on one profile
  // would otherwise have the server refuse BOTH lists — an unrelated rename on
  // another profile blocked by a provider someone half-added. That is the
  // deadlock the unresolved-value work already had to undo once.
  it('cleans both lists the same way, because a mode gets providers too', () => {
    const list = [
      saved({ providers: { moza: {} } }),
      mode({ providers: { govee: { scene: 'Sunset' }, apps: {} } }),
    ];
    expect(forStorage(list).map((r) => r.providers)).toEqual([
      {},
      { govee: { scene: 'Sunset' } },
    ]);
  });

  it('is happy with no list at all', () => {
    expect(forStorage(undefined)).toEqual([]);
  });
});

describe('modeOverlap ignores blocks that hold nothing', () => {
  // A profile with an empty Govee block does not beat the mode's Govee at
  // runtime — it is not stored, so the mode's lighting is what fires. Claiming
  // the clash would warn about something that does not happen, and in the wrong
  // direction.
  it('does not let a blank block on the profile claim the mode loses', () => {
    const p = saved({ providers: { govee: {} } });
    const s = mode({ providers: { govee: { scene: 'Sunset' } } });
    expect(modeOverlap(p, s)).toEqual([]);
  });

  it('does not let a blank block on the mode invent a clash either', () => {
    const p = saved({ providers: { govee: { scene: 'Race' } } });
    expect(modeOverlap(p, mode({ providers: { govee: {} } }))).toEqual([]);
  });

  it('still names a real one', () => {
    const p = saved({ providers: { govee: { scene: 'Race' } } });
    const s = mode({ providers: { govee: { scene: 'Sunset' } } });
    expect(modeOverlap(p, s)).toEqual(['govee']);
  });
});

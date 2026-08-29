// editorState.js — the list operations the browser editor performs on its
// draft, kept out of the page so they can be tested without a browser.
//
// Identity is why this file exists. A profile that has never been saved has no
// id — ids are slugified from the name at save time, so that "Space Sim"
// becomes `space-sim` in the YAML rather than `profile-4` — which means two
// new profiles both answer to "", and any lookup by id follows the wrong one.
// Every function here therefore works on the profile OBJECT. An id is used in
// exactly one place: carrying the selection across a reload, which replaces
// every object with a fresh one and leaves the id as the only thing in common.
//
// Scenes
// ------
// A scene has the same SHAPE as a profile — `{ id, name, color, providers }` —
// and none of its meaning. A profile is a claim about who is at the rig: it is
// exclusive, it persists, and a restricted one is gated behind a deliberate
// hold. A scene is a moment: lights, a playlist, a script, fired and forgotten.
// It never writes the shared active-profile state, because that state answers
// "which human is at the rig" and a lighting preset must not be able to change
// what a child is allowed to launch.
//
// Because the shape is identical, the list operations below are shape-generic
// and are used for both lists. The names kept their `Profile` suffix where
// existing callers and tests already use them; what a function does not do is
// care which list it was handed. Only the functions that touch the *reference*
// between the two — a profile naming scenes it also runs — know the difference.

/** A blank profile. Colour matches the inspector's own accent. */
export const newProfile = () => ({
  id: '',
  name: 'New profile',
  color: '#2255cc',
  restricted: false,
  providers: {},
});

/**
 * A blank scene.
 *
 * Deliberately missing `restricted`: there is nothing to gate. A hold exists to
 * stop a child pressing a key that hands them full force feedback, and a scene
 * cannot hand them anything — it does not touch who is at the rig. Storing the
 * flag as `false` would still put the word in the record, and the next reader
 * of the JSON would reasonably wonder what a gated scene is.
 *
 * The violet is the scene accent used throughout the editor, so a new scene
 * looks like a scene before it is named.
 */
export const newScene = () => ({
  id: '',
  name: 'New scene',
  color: '#7c5cff',
  providers: {},
});

export function addProfile(profiles) {
  const profile = newProfile();
  return { profiles: [...profiles, profile], selected: profile };
}

export function addScene(scenes) {
  const scene = newScene();
  return { scenes: [...scenes, scene], selected: scene };
}

/** Drop one record from its list. Shape-generic: profiles and scenes both. */
export function removeProfile(profiles, profile) {
  const next = profiles.filter((p) => p !== profile);
  return { profiles: next, selected: next[0] ?? null };
}

/**
 * Move `moved` to sit before or after `onto`.
 *
 * Order is what the inspector's dropdown shows, so it is worth arranging. The
 * target is taken by reference rather than by index because removing the
 * dragged profile shifts every index after it.
 */
export function moveProfile(profiles, moved, onto, after = false) {
  if (!moved || !onto || moved === onto) return profiles;
  const next = profiles.filter((p) => p !== moved);
  next.splice(next.indexOf(onto) + (after ? 1 : 0), 0, moved);
  return next;
}

/** Re-find the selection after a reload replaced every profile object. */
export function keepSelection(profiles, previous) {
  const id = previous?.id;
  return (id && profiles.find((p) => p.id === id)) || profiles[0] || null;
}

/** Does this profile match what was typed in the search box? */
export function matchesSearch(profile, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  return [profile?.name, profile?.id, ...Object.keys(profile?.providers ?? {})]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

// ---------------------------------------------------------------------------
// What can be added to the thing on screen
// ---------------------------------------------------------------------------

/**
 * Which lists a provider may be offered on.
 *
 * A provider declares `contexts: ['profile']` or `['profile','scene']`. One
 * that declares nothing is treated as profile-only: profiles are the default
 * surface, and the failure worth defaulting away from is a scene quietly
 * reaching hardware it was never meant to touch.
 */
export const providerContexts = (provider) =>
  Array.isArray(provider?.contexts) && provider.contexts.length ? provider.contexts : ['profile'];

/**
 * Everything the third column can offer for the record on screen, in one list.
 *
 * Providers and scenes are added the same way and are therefore searched
 * together — the question being asked is "what else should this do?", and
 * whether the answer is a piece of hardware or a scene is the editor's
 * bookkeeping, not the user's. They stay in two groups so the list is still
 * readable, and the caller renders them in the order returned.
 *
 * `added: true` is returned rather than filtered out. An entry that vanishes
 * when used leaves the user wondering whether they imagined it; one that stays
 * and greys out says "yes, that one, it is already on". Nothing is offered
 * twice — a provider appears once in a record's providers map, and a scene
 * reference is an id in a set.
 *
 * @param {object} opts
 * @param {object[]} [opts.providers]  as sent by getProviders, with `contexts`
 * @param {object[]} [opts.scenes]     the scene draft
 * @param {object} [opts.record]       the profile or scene being edited
 * @param {'profiles'|'scenes'} [opts.kind]  which list `record` came from
 * @param {string} [opts.query]        the third column's search box
 * @param {Function} [opts.match]      how to test one entry, for tests
 * @returns {Array<{ type: 'provider'|'scene', id, label, added, provider?, scene? }>}
 */
export function offers({ providers = [], scenes = [], record = null, kind = 'profiles', query = '', match = matchesSearch } = {}) {
  const context = kind === 'scenes' ? 'scene' : 'profile';
  const out = [];

  for (const provider of providers) {
    if (!providerContexts(provider).includes(context)) continue;
    if (!match({ name: provider.label, id: provider.id }, query)) continue;
    out.push({
      type: 'provider',
      id: provider.id,
      label: provider.label,
      added: Boolean(record?.providers?.[provider.id]),
      provider,
    });
  }

  // Scenes are offered on profiles and nowhere else. A scene running a scene
  // would be a graph to resolve and a cycle to detect, for a feature nobody has
  // asked for; a profile composing scenes is the whole point of them.
  if (context === 'profile') {
    for (const scene of scenes) {
      // A scene with no id has never been saved, so there is nothing for a
      // profile to reference yet — it gets an id within the second.
      if (!scene.id) continue;
      if (!match(scene, query)) continue;
      out.push({
        type: 'scene',
        id: scene.id,
        label: scene.name || '(unnamed)',
        added: referencesScene(record, scene.id),
        scene,
      });
    }
  }

  return out;
}

export function slugify(name, taken = [], fallback = 'profile') {
  const base =
    String(name || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
    fallback;
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Give every unsaved record an id, in place, before the list is saved.
 *
 * In place because the editor keeps showing these same objects afterwards: a
 * copy would leave the panel displaying a profile with no id while the stored
 * one has one.
 *
 * Profiles and scenes are slugged independently — they are separate lists and
 * a profile only ever names a scene from the scene list, so `brian` may be both
 * a profile and a scene without either becoming ambiguous.
 */
export function withIds(profiles, fallback = 'profile') {
  const taken = [];
  for (const p of profiles) {
    if (!p.id) p.id = slugify(p.name, taken, fallback);
    taken.push(p.id);
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// Scene references
//
// A profile names the scenes it also runs, by id, in `profile.scenes`. Ids
// rather than objects because this is what gets stored: the reference has to
// survive being written to global settings and read back by the plugin, and an
// id is the only thing that does. Ids are permanent once slugged, so renaming a
// scene never breaks a profile that names it.
// ---------------------------------------------------------------------------

/** The scene ids a profile references, always an array. */
export const sceneRefs = (profile) => profile?.scenes ?? [];

/** Does this profile run that scene as well as its own providers? */
export function referencesScene(profile, sceneId) {
  return sceneRefs(profile).includes(sceneId);
}

/**
 * Add or remove one scene reference, in place.
 *
 * The key is deleted rather than left as an empty array when the last reference
 * goes, so a profile that references nothing looks in storage exactly like one
 * written before scenes existed.
 */
export function setSceneRef(profile, sceneId, on) {
  if (!profile || !sceneId) return profile;
  const next = sceneRefs(profile).filter((id) => id !== sceneId);
  if (on) next.push(sceneId);
  if (next.length) profile.scenes = next;
  else delete profile.scenes;
  return profile;
}

/** Every profile that references this scene, in list order. */
export function profilesUsingScene(profiles, sceneId) {
  return (profiles ?? []).filter((p) => referencesScene(p, sceneId));
}

/**
 * Drop a scene from every profile that references it, in place.
 *
 * Called when a scene is deleted. Leaving the reference behind would give the
 * profile a silent dead limb: it would still claim to run a scene, and the
 * runtime would log a missing-scene warning that nobody reads. Returns the
 * profiles that changed, so the deletion can say what it touched.
 */
export function detachScene(profiles, sceneId) {
  const affected = profilesUsingScene(profiles, sceneId);
  for (const p of affected) setSceneRef(p, sceneId, false);
  return affected;
}

/**
 * Provider ids a referenced scene would contribute but the profile already sets
 * itself.
 *
 * The runtime resolves this collision in the profile's favour — see
 * `withScenes` in profileSwitch.js — which is the right call and also invisible
 * unless the editor says so. A user who sets Govee on a profile and then adds a
 * lighting scene to it should be told the scene's lighting will not be used,
 * rather than discovering it when the room stays the wrong colour.
 */
export function sceneOverlap(profile, scene) {
  // Blank blocks on either side are excluded because they are not stored — see
  // `blankBlocks` below. A profile with an empty Govee block does NOT beat the
  // scene's Govee at runtime; it contributes nothing at all, and the scene's
  // lighting is what actually fires. Counting it would make the editor warn
  // about a clash that does not happen, in the profile's favour, wrongly.
  const mine = configuredBlocks(profile);
  return configuredBlocks(scene).filter((id) => mine.includes(id));
}

/**
 * Should an automatic save wait?
 *
 * The editor saves as you type, and `withIds` slugs a permanent id out of the
 * name the first time a profile is stored. Those two together would freeze
 * "Ka" as the id of a profile called "Kai", because the save fires between two
 * keystrokes. So while the caret is in the name field of a profile that has
 * never been saved, the save waits — the change stays dirty and is written the
 * moment the field is left.
 *
 * Only for profiles with no id: renaming a saved profile leaves its id alone,
 * so there is nothing to protect and no reason to make the user click away.
 */
export function holdForNaming(profiles, activeField) {
  return activeField === 'name' && (profiles ?? []).some((p) => !p.id);
}

/**
 * How the wheelbase names its setup slots: `S3`, optionally followed by a
 * dashed summary of the values in it, optionally marked as the live one.
 *
 * Anchored at both ends on purpose. A Govee scene called "S1 Sunset" or a MOZA
 * preset called "S2" must pass straight through — only a label that is entirely
 * a slot reference is a slot reference.
 */
const SLOT_LABEL = /^S(\d+)(?:\s*[—–-]\s*[^()]*?)?(\s*\(current\))?$/;

/**
 * Present a provider's option label the way its own application does.
 *
 * The Fanatec app calls these "Setup 1"…"Setup 5", so that is what the editor
 * should call them; `S3 — FFB 60, FUL 100, FEI 100` is the plugin reading the
 * base out loud, which is interesting once and noise every time after. The
 * "(current)" marker survives, because which slot the base is actually on is
 * the one piece of live information the list carries.
 *
 * Done here rather than in the provider because the provider's label is also
 * what the logs and the property inspector use — see the report accompanying
 * this change for the tidier fix in fanatecBase.js.
 */
export function optionLabel(label) {
  const m = SLOT_LABEL.exec(String(label ?? '').trim());
  return m ? `Setup ${m[1]}${m[2] ? ' (current)' : ''}` : String(label ?? '');
}

// ---------------------------------------------------------------------------
// Stored values whose option has gone away
//
// A select field's stored value is a reference to something an external app
// owns: a Pit House preset uuid, a Govee scene name. That app can delete,
// rename or repackage the thing at any time without the profile changing, and
// then the stored value matches no option in the list.
//
// This used to deadlock the editor. MOZA treated a missing preset as a
// validation error; `saveProfiles` refuses the whole list when anything fails
// validation; and the dropdown had no option matching the stored uuid, so the
// value could not be changed either. One profile pointing at a repackaged
// preset meant no profile could be saved, and the only way out was deleting
// the MOZA block from every one of them.
//
// The rule now: an unresolved value is DATA, not an error. It is kept exactly
// as stored, shown as itself, and the block that holds it is locked rather
// than edited — because a config whose anchor is gone cannot be meaningfully
// adjusted, only removed. Nothing here blocks a save.
// ---------------------------------------------------------------------------

/**
 * Why a stored select value could not be resolved against its options — or
 * null when it resolves fine, is empty, or the field is not a select.
 *
 *   'missing'      the list is authoritative and this value is not in it. The
 *                  thing it names is gone.
 *   'unverifiable' no options came back at all. That is what an unreachable
 *                  wheelbase or a closed Pit House looks like, and it says
 *                  nothing whatsoever about the stored value — so the editor
 *                  must not call it missing.
 *
 * The two are told apart by whether there is a domain to check against. A
 * non-empty list is one, whatever its provenance: it is the provider's own
 * account of what exists. `optionsLive` (set in piBridge) carries the other
 * case — a provider with no options() at all, whose schema list IS the whole
 * domain even when that list is empty.
 */
export function unknownSelectValue(field, value) {
  if (field?.type !== 'select') return null;
  if (value === undefined || value === null || value === '') return null;

  const options = field.options ?? [];
  // String-compared because that is how the option list is matched when it is
  // rendered: a slot stored as the number 2 and offered as the string "2" is
  // the same slot, and must not be reported missing.
  if (options.some((o) => String(o.value) === String(value))) return null;

  return {
    key: field.key,
    label: field.label,
    value,
    why: options.length || field.optionsLive ? 'missing' : 'unverifiable',
  };
}

/**
 * Every stored value in this provider's config that its options cannot explain.
 *
 * Provider-agnostic on purpose: a Govee scene renamed in the Govee app hits
 * exactly the wall a repackaged MOZA preset does, and there is nothing about
 * either that the editor should know by name.
 */
export function unknownValues(provider, cfg) {
  return (provider?.fields ?? [])
    .map((field) => unknownSelectValue(field, cfg?.[field.key]))
    .filter(Boolean);
}

/**
 * Should this whole provider block be locked?
 *
 * Only for a genuinely missing value, never for an unverifiable one. Locking
 * on "no options came back" would grey out a profile's pedal forces every time
 * Pit House happened to be closed — which is most of the time, and which is
 * crying wolf: nothing is known to be wrong. A missing anchor is different, and
 * the config as a whole is not meaningfully editable without it.
 */
export const blocksEditing = (unknowns) => (unknowns ?? []).some((u) => u.why === 'missing');

// ---------------------------------------------------------------------------
// Blocks that hold nothing yet
//
// Adding a provider to a profile creates `providers.moza = {}` — a block with
// no configuration in it, because the user has not had a chance to configure it
// yet. Every provider quite correctly refuses that: "MOZA is enabled but no
// preset or pedal setting is chosen", "govee is enabled but no scene is
// selected". With autosave running, the act of adding a provider was therefore
// the act of being told off, half a second later, for a state the user had had
// no opportunity to leave.
//
// The rule now: an empty block is INCOMPLETE, not invalid, and incomplete
// configuration is not stored. The draft in the page keeps it — it is on
// screen, it can be filled in, it can be removed — but it is left out of the
// save. `saveProfiles` still refuses a genuinely invalid list; it is simply
// never handed a block that says nothing.
//
// Withholding rather than saving-and-explaining, because the alternative is
// worse in both directions. Sending an empty block means the server refuses the
// WHOLE list — one half-added provider would stop an unrelated profile's rename
// from saving, which is the deadlock the unresolved-value work already had to
// undo once. And a block that were somehow stored empty would fail at the one
// moment it matters, when a key is pressed. Withheld, the stored profile always
// does exactly what it appears to do, and the worst case is a provider the user
// walked away from not being there — which the editor says, loudly, in
// `unset`-flagged form.
// ---------------------------------------------------------------------------

/** Does this provider block hold no configuration whatsoever? */
export const isBlank = (cfg) => !cfg || typeof cfg !== 'object' || Object.keys(cfg).length === 0;

/** Provider ids on this record whose block holds nothing. */
export function blankBlocks(record) {
  return Object.entries(record?.providers ?? {})
    .filter(([, cfg]) => isBlank(cfg))
    .map(([id]) => id);
}

/** Provider ids on this record that actually configure something. */
export function configuredBlocks(record) {
  return Object.entries(record?.providers ?? {})
    .filter(([, cfg]) => !isBlank(cfg))
    .map(([id]) => id);
}

/**
 * One record as it should be STORED: blank blocks left behind.
 *
 * Copied rather than edited, and only when there is something to leave out. The
 * editor keeps showing these same objects — a record whose blank block was
 * deleted in place would lose the block from the screen the moment it saved,
 * and the user would watch the thing they just added disappear.
 */
export function withoutBlankBlocks(record) {
  const blanks = blankBlocks(record);
  if (!blanks.length) return record;
  const providers = { ...record.providers };
  for (const id of blanks) delete providers[id];
  return { ...record, providers };
}

/** A whole list, ready to be sent to `saveProfiles`. */
export const forStorage = (records) => (records ?? []).map(withoutBlankBlocks);

/**
 * Coerce one edited field for storage; undefined means "remove this key".
 *
 * Numbers must not be stored as strings, and pedal travel is measured in
 * tenths of a millimetre, so integers alone will not do. Anything that is not
 * a number stays text — a MOZA preset uuid is not a quantity.
 */
export function fieldValue(raw) {
  if (typeof raw === 'boolean') return raw;
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const numeric = typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw));
  return numeric ? Number(raw) : raw;
}

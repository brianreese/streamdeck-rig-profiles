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
  const mine = Object.keys(profile?.providers ?? {});
  return Object.keys(scene?.providers ?? {}).filter((id) => mine.includes(id));
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

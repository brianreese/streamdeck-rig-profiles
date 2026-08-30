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
// Modes
// -----
// A Mode has the same SHAPE as a profile — `{ id, name, color, providers }` —
// and none of its meaning. A profile is a claim about who is at the rig: it is
// exclusive, it persists, and a restricted one is gated behind a deliberate
// hold. A Mode is something the rig does rather than someone it thinks is at
// it: lights, VR, a playlist, a script. It never writes the shared
// active-profile state, because that state answers "which human is at the rig"
// and a lighting preset must not be able to change what a child may launch.
//
// Whether a Mode is stateful is not a property it asserts. It is a property of
// the providers inside it: one that implements isActive() can say whether it is
// currently in effect, and a Mode holding at least one of those has an
// active/inactive state on its key. A Mode holding none fires and forgets. The
// entity does not decide; the providers do — see `modeStatefulness` below.
//
// Because the shape is identical, the list operations below are shape-generic
// and are used for both lists. The names kept their `Profile` suffix where
// existing callers and tests already use them; what a function does not do is
// care which list it was handed. Only the functions that touch the *reference*
// between the two — a profile naming Modes it also activates — know the
// difference.

/** A blank profile. Colour matches the inspector's own accent. */
export const newProfile = () => ({
  id: '',
  name: 'New profile',
  color: '#2255cc',
  restricted: false,
  providers: {},
});

/**
 * A blank Mode.
 *
 * Deliberately missing `restricted`: there is nothing to gate. A hold exists to
 * stop a child pressing a key that hands them full force feedback, and a Mode
 * cannot hand them anything — it does not touch who is at the rig. That holds
 * for a Mode that reports itself active too: its on/off is a fact about the
 * Mode, not about who is sitting there. Storing the flag as `false` would still
 * put the word in the record, and the next reader of the JSON would reasonably
 * wonder what a gated Mode is.
 *
 * The violet is the Mode accent used throughout the editor, so a new Mode looks
 * like a Mode before it is named.
 */
export const newMode = () => ({
  id: '',
  name: 'New mode',
  color: '#7c5cff',
  providers: {},
});

export function addProfile(profiles) {
  const profile = newProfile();
  return { profiles: [...profiles, profile], selected: profile };
}

export function addMode(modes) {
  const mode = newMode();
  return { modes: [...modes, mode], selected: mode };
}

/** Drop one record from its list. Shape-generic: profiles and Modes both. */
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
// Provider instances
//
// A record's `providers` map is keyed by provider id — except that a provider
// declaring `repeatable: true` may appear on one record more than once, and
// then the extra keys carry a suffix to keep them distinct:
//
//   providers: {
//     "state-flag":         { flag: "vr" },
//     "state-flag#2":       { flag: "assists", whenOff: true },
//     "govee":              { scene: "Racing" },
//   }
//
// The reason instances exist rather than a list inside one block: a Mode
// routinely asserts several facts and they may point in different directions —
// turn `vr` on AND `assists` off. A list of names inside one block cannot say
// that, because the invert belongs to the block rather than to each name.
//
// A KEY is what the config is stored under and what every DOM hook here is
// built from. A provider ID is what resolves to a schema, a label and a set of
// capabilities. They are equal for every provider that is not repeatable and
// for the first instance of one that is, which is exactly why confusing the two
// is so easy and why nothing below does it: every lookup into the provider list
// goes through `providerIdOf`.
//
// This mirrors `providerIdOf` in src/providers/index.js deliberately rather
// than importing it: that module pulls in the whole registry — hardware
// drivers, MQTT, the filesystem — and this one is loaded straight into a
// browser page. The parse is one line and the shape is fixed by the stored
// config, which both sides read.
// ---------------------------------------------------------------------------

/** The provider a config key names: `"state-flag#2"` -> `"state-flag"`. */
export function providerIdOf(key) {
  const s = String(key ?? '');
  const at = s.indexOf('#');
  return at === -1 ? s : s.slice(0, at);
}

/** The instance suffix on a config key, or `''` for the first/only one. */
export function instanceOf(key) {
  const s = String(key ?? '');
  const at = s.indexOf('#');
  return at === -1 ? '' : s.slice(at + 1);
}

/** Every key on this record belonging to one provider, in stored order. */
export function instanceKeys(record, providerId) {
  return Object.keys(record?.providers ?? {}).filter((k) => providerIdOf(k) === providerId);
}

/**
 * The key a new instance of `providerId` should be stored under.
 *
 * The first one is the bare id, so a record holding one of something looks in
 * storage exactly as it did before instances existed and nothing has to be
 * migrated. After that: `#2`, `#3` — the lowest number not already in use on
 * this record.
 *
 * Why a counter and not something meaningful. The key has to be minted at the
 * moment ADD is clicked, when the block is still empty and there is nothing to
 * name it after; and it has to hold still afterwards, because it is what the
 * stored config is keyed by. Deriving it from a value — `state-flag#vr` — would
 * mean re-keying the block on every keystroke in the flag field, which is a
 * delete and an insert of the user's config per character, and two blank blocks
 * would collide at `#`. A number owes nothing to the contents and so never has
 * to change.
 *
 * Existing keys are never renumbered, including when one is removed: removing
 * `#2` from three instances leaves `state-flag` and `#3` exactly as they are,
 * and only the NEXT add takes the freed `#2`. Reusing a gap is safe precisely
 * because nothing outside the record's own map ever names these keys, and it
 * keeps them short; renumbering would not be, because it would silently
 * repoint stored config.
 */
export function nextInstanceKey(record, providerId) {
  const taken = new Set(Object.keys(record?.providers ?? {}));
  if (!taken.has(providerId)) return providerId;
  let n = 2;
  while (taken.has(`${providerId}#${n}`)) n++;
  return `${providerId}#${n}`;
}

/** Whether a provider, as sent by getProviders, may be added more than once. */
export const isRepeatable = (provider) => provider?.repeatable === true;

/**
 * A one-line summary of what one block is set to, for telling two of them apart.
 *
 * Two blocks both headed "Rig State Flag" and nothing else is the failure this
 * exists to prevent: with instances, the label is no longer an identity.
 *
 * Derived here from the declared schema rather than taken from the provider's
 * own `describe()`. `describe()` is better prose — "sets vr", "clears assists"
 * — but it is a function of the config, so it lives plugin-side and could only
 * reach the page as a round-trip per keystroke; and this line has to be right
 * *while the user is typing the value that distinguishes the two blocks*, which
 * is the one moment a debounced round-trip would be wrong. So the page reads
 * the same schema it is already rendering: the first field holding a value,
 * plus any boolean that is on. Provider-agnostic, like everything else here —
 * nothing in the editor knows what a flag or a scene is.
 */
export function blockSummary(provider, cfg) {
  if (isBlank(cfg)) return '';
  const values = [];
  const flags = [];

  for (const f of provider?.fields ?? []) {
    const v = cfg?.[f.key];
    if (v === undefined || v === null || v === '') continue;
    // A boolean reads as its own label — "active when off" says more than
    // "whenOff: true" — while everything else is worth showing as its value,
    // because the value is what differs between two instances.
    if (f.type === 'boolean') { if (v) flags.push(String(f.label ?? f.key).toLowerCase()); }
    else if (values.length < 2) values.push(String(v));
  }
  const parts = [...values, ...flags];
  // A block holding only values for fields the schema no longer declares still
  // holds something, and saying nothing about it would look like a bug.
  if (!parts.length) return Object.keys(cfg).join(', ');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// What can be added to the thing on screen
// ---------------------------------------------------------------------------

/**
 * Which lists a provider may be offered on.
 *
 * A provider declares `contexts: ['profile']` or `['profile','mode']`. One
 * that declares nothing is treated as profile-only: profiles are the default
 * surface, and the failure worth defaulting away from is a Mode quietly
 * reaching hardware it was never meant to touch.
 *
 * Says nothing about whether the provider can report its own state — that is
 * `reportsState`, and the two are independent. Govee belongs in a Mode and
 * cannot report itself; both facts are true at once.
 */
export const providerContexts = (provider) =>
  Array.isArray(provider?.contexts) && provider.contexts.length ? provider.contexts : ['profile'];

/**
 * Everything the third column can offer for the record on screen, in one list.
 *
 * Providers and Modes are added the same way and are therefore searched
 * together — the question being asked is "what else should this do?", and
 * whether the answer is a piece of hardware or a Mode is the editor's
 * bookkeeping, not the user's. They stay in two groups so the list is still
 * readable, and the caller renders them in the order returned.
 *
 * `added: true` is returned rather than filtered out. An entry that vanishes
 * when used leaves the user wondering whether they imagined it; one that stays
 * and greys out says "yes, that one, it is already on".
 *
 * A REPEATABLE provider is never `added`, however many instances the record
 * already holds, because there is always another one to add — a Mode asserting
 * two flags needs the row to stay live after the first. It carries `count`
 * instead, so the row can say how many are on rather than pretending to be
 * untouched. Everything else keeps the old rule: one block, then greyed out.
 * A Mode reference is an id in a set and can never be added twice.
 *
 * @param {object} opts
 * @param {object[]} [opts.providers]  as sent by getProviders, with `contexts`
 * @param {object[]} [opts.modes]      the Mode draft
 * @param {object} [opts.record]       the profile or Mode being edited
 * @param {'profiles'|'modes'} [opts.kind]  which list `record` came from
 * @param {string} [opts.query]        the third column's search box
 * @param {Function} [opts.match]      how to test one entry, for tests
 * @returns {Array<{ type, id, label, added, count, repeatable, provider?, mode? }>}
 */
export function offers({ providers = [], modes = [], record = null, kind = 'profiles', query = '', match = matchesSearch } = {}) {
  const context = kind === 'modes' ? 'mode' : 'profile';
  const out = [];

  for (const provider of providers) {
    if (!providerContexts(provider).includes(context)) continue;
    if (!match({ name: provider.label, id: provider.id }, query)) continue;
    // Counted across instances rather than looked up by id: after the first,
    // this provider's blocks are stored under suffixed keys, and a bare-id
    // lookup would report a record holding three of them as holding none.
    const count = instanceKeys(record, provider.id).length;
    out.push({
      type: 'provider',
      id: provider.id,
      label: provider.label,
      count,
      repeatable: isRepeatable(provider),
      added: count > 0 && !isRepeatable(provider),
      provider,
    });
  }

  // Modes are offered on profiles and nowhere else. A Mode activating a Mode
  // would be a graph to resolve and a cycle to detect, for a feature nobody has
  // asked for; a profile composing Modes is the whole point of them.
  if (context === 'profile') {
    for (const mode of modes) {
      // A Mode with no id has never been saved, so there is nothing for a
      // profile to reference yet — it gets an id within the second.
      if (!mode.id) continue;
      if (!match(mode, query)) continue;
      const added = referencesMode(record, mode.id);
      // A Mode is never repeatable: the reference is an id in a set, and a
      // profile activating the same Mode twice would be one activation.
      out.push({
        type: 'mode',
        id: mode.id,
        label: mode.name || '(unnamed)',
        count: added ? 1 : 0,
        repeatable: false,
        added,
        mode,
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
 * Profiles and Modes are slugged independently — they are separate lists and
 * a profile only ever names a Mode from the Mode list, so `brian` may be both
 * a profile and a Mode without either becoming ambiguous.
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
// Mode references
//
// A profile names the Modes it also activates, by id, in `profile.modes`. Ids
// rather than objects because this is what gets stored: the reference has to
// survive being written to global settings and read back by the plugin, and an
// id is the only thing that does. Ids are permanent once slugged, so renaming a
// Mode never breaks a profile that names it.
//
// The reference is one-way and one-shot. A profile ACTIVATES the Modes it
// names, and takes no further interest: whether a Mode goes on to report itself
// active is the Mode key's business, not the profile's. Nothing here reads
// `reportsState`, and that is the point — a profile behaves identically towards
// a Mode that can report itself and one that cannot.
// ---------------------------------------------------------------------------

/** The Mode ids a profile references, always an array. */
export const modeRefs = (profile) => profile?.modes ?? [];

/** Does this profile activate that Mode as well as its own providers? */
export function referencesMode(profile, modeId) {
  return modeRefs(profile).includes(modeId);
}

/**
 * Add or remove one Mode reference, in place.
 *
 * The key is deleted rather than left as an empty array when the last reference
 * goes, so a profile that references nothing looks in storage exactly like one
 * written before Modes existed.
 */
export function setModeRef(profile, modeId, on) {
  if (!profile || !modeId) return profile;
  const next = modeRefs(profile).filter((id) => id !== modeId);
  if (on) next.push(modeId);
  if (next.length) profile.modes = next;
  else delete profile.modes;
  return profile;
}

/** Every profile that references this Mode, in list order. */
export function profilesUsingMode(profiles, modeId) {
  return (profiles ?? []).filter((p) => referencesMode(p, modeId));
}

/**
 * Drop a Mode from every profile that references it, in place.
 *
 * Called when a Mode is deleted. Leaving the reference behind would give the
 * profile a silent dead limb: it would still claim to activate a Mode, and the
 * runtime would log a missing-mode warning that nobody reads. Returns the
 * profiles that changed, so the deletion can say what it touched.
 */
export function detachMode(profiles, modeId) {
  const affected = profilesUsingMode(profiles, modeId);
  for (const p of affected) setModeRef(p, modeId, false);
  return affected;
}

// ---------------------------------------------------------------------------
// Whether a Mode's key will have an on/off state
//
// This is the one thing about a Mode the user cannot see by reading its
// provider list, and it decides how the key behaves. Two Modes can look
// identical on screen — same shape, same three blocks — and one of them lights
// up to say it is on while the other fires and is over. What separates them is
// a capability that is invisible in the UI: whether any provider inside can
// answer "am I currently in effect?".
//
// So the editor says it, in words, next to the key preview. Without that, one
// action with two behaviours is exactly the confusion it sounds like.
//
// Three rules, and each is load-bearing:
//
//   * the verdict comes from the PROVIDERS, never from the Mode. A Mode does
//     not declare itself stateful and cannot be made stateful by ticking
//     something; adding a provider that reports state is the only way in;
//   * only providers that answer count. A Mode may freely mix them with ones
//     that cannot — lights and throwaway scripts have no honest answer to give
//     — and the non-answering ones neither add to the verdict nor spoil it;
//   * only CONFIGURED blocks count. A block holding nothing is not stored and
//     therefore does not run, so it cannot report anything either. Same rule
//     `modeOverlap` follows, for the same reason: the editor must describe what
//     the saved Mode will do, not what the draft looks like.
//
// The last rule has a visible consequence worth handling rather than hiding.
// Add the one provider that reports state, and until you fill it in the key
// still has no state — so `pending` names those blocks and the caller can say
// "once you have set it up" instead of appearing to ignore what was just added.
// ---------------------------------------------------------------------------

/** Can this provider, as sent by getProviders, report whether it is in effect? */
export const reportsState = (provider) => provider?.reportsState === true;

/**
 * What a Mode's key will show, derived from what is actually inside it.
 *
 * Blocks are counted by KEY and named by PROVIDER, which is why the two are
 * kept apart here. Two instances of the same flag provider are two blocks and
 * one name — "Rig State Flag, Rig State Flag can report whether they are
 * currently in effect" is not a sentence anyone should read — so the labels are
 * deduplicated. The verdict itself is unaffected: one reporter or three, the
 * key gains an on/off state either way.
 *
 * @param {object} record            the Mode being edited
 * @param {object[]} providers       as sent by getProviders, with `reportsState`
 * @returns {{ stateful: boolean, reporters: string[], quiet: string[], pending: string[] }}
 *   `reporters` are the configured providers that give the key its on/off,
 *   `quiet` the configured ones that simply run, and `pending` the ones that
 *   would report state but hold nothing yet. Labels, not ids: every caller is
 *   about to show them to a human.
 */
export function modeStatefulness(record, providers = []) {
  const of = (key) => providers.find((p) => p.id === providerIdOf(key));
  const label = (key) => of(key)?.label ?? providerIdOf(key);
  const knows = (key) => reportsState(of(key));
  const names = (keys) => [...new Set(keys.map(label))];

  const configured = configuredBlocks(record);
  const reporters = names(configured.filter(knows));
  const quiet = names(configured.filter((key) => !knows(key)));
  // A provider with one finished instance and one empty one is not pending:
  // the key already has its state, and being told to "finish it" would be
  // wrong. Only a provider with nothing configured at all is waiting.
  const pending = names(blankBlocks(record).filter(knows)).filter((n) => !reporters.includes(n));

  return { stateful: reporters.length > 0, reporters, quiet, pending };
}

/**
 * Provider ids a referenced Mode would contribute but the profile already sets
 * itself.
 *
 * The runtime resolves this collision in the profile's favour — see
 * profileSwitch.js — which is the right call and also invisible unless the
 * editor says so. A user who sets Govee on a profile and then adds a lighting
 * Mode to it should be told the Mode's lighting will not be used, rather than
 * discovering it when the room stays the wrong colour.
 *
 * Compared by KEY rather than by provider id, which is the right unit now that
 * a provider can appear more than once. Two instances under different keys are
 * additive and do not collide — a profile that sets `vr` and a Mode that clears
 * `assists` are both doing their own thing, and warning about them would be
 * warning about nothing. The same key on both sides is the same block twice,
 * which is the collision this is for.
 */
export function modeOverlap(profile, mode) {
  // Blank blocks on either side are excluded because they are not stored — see
  // `blankBlocks` below. A profile with an empty Govee block does NOT beat the
  // Mode's Govee at runtime; it contributes nothing at all, and the Mode's
  // lighting is what actually fires. Counting it would make the editor warn
  // about a clash that does not happen, in the profile's favour, wrongly.
  const mine = configuredBlocks(profile);
  return configuredBlocks(mode).filter((id) => mine.includes(id));
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

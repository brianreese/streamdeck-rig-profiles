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

/** A blank profile. Colour matches the inspector's own accent. */
export const newProfile = () => ({
  id: '',
  name: 'New profile',
  color: '#2255cc',
  restricted: false,
  providers: {},
});

export function addProfile(profiles) {
  const profile = newProfile();
  return { profiles: [...profiles, profile], selected: profile };
}

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

export function slugify(name, taken = []) {
  const base =
    String(name || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
    'profile';
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Give every unsaved profile an id, in place, before the list is saved.
 *
 * In place because the editor keeps showing these same objects afterwards: a
 * copy would leave the panel displaying a profile with no id while the stored
 * one has one.
 */
export function withIds(profiles) {
  const taken = [];
  for (const p of profiles) {
    if (!p.id) p.id = slugify(p.name, taken);
    taken.push(p.id);
  }
  return profiles;
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

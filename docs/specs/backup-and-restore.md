# Spec — Backup and restore

- **Status:** Proposed — needs review before implementation (ADR-0001)
- **Date:** 2026-09-02
- **Prompted by:** the second total loss of global settings, `docs/BACKLOG.md` §8

## Why

Global settings hold every profile, Mode, avatar and key this plugin has. Stream
Deck keeps them in memory and flushes on a clean exit, so a force-kill loses
everything since the last flush. That has now happened twice.

The mirror shipped on 2026-09-02 (`settingsBackup.js`) stops the *silent* case:
the store cannot be re-seeded over any more, and a healthy mirror is restored at
startup. What it does not give anyone is a copy they can hold, inspect, move to
another machine, or roll back to a chosen point. That is what this adds.

## What already exists

| Piece | State |
|---|---|
| `exportYaml` PI request, `profilesToYaml()` | Shipped. Read-only textarea + Copy button in the editor. |
| `settings.backup.json` + 20 generations | Shipped. Written on every settings write. |
| `recoverIfEmpty()` at startup | Shipped. Restores when the store is empty but the marker says it should not be. |
| Any import, upload, or UI restore | **Does not exist.** Restore today means editing `config/profiles.yaml`. |

## The audit: what a YAML export does not capture

This is the answer to "make sure the backup captures it all". Four gaps, and
only one of them is deliberate.

1. **Avatar image bytes.** `profilesToYaml` emits `avatar: brian.png` — a
   filename. The image lives in `%APPDATA%\com.rig.profiles\avatars\`. Restore a
   YAML onto a clean machine and every profile references an image that is not
   there. This is the gap that made the incident's reconstruction incomplete.
2. **The Govee API key.** Deliberately excluded, and correctly so for export —
   that file is meant to be committable. It is *not* correct for a backup: a
   restore that leaves the lights dead has not restored anything. The two
   artifacts need different rules, which is the core decision below.
3. **`mozaClosePitHouse`, `mozaReopenPitHouse`, `fanatecAutoStart`.** Real
   configuration, set in the Hardware settings pane, and `profilesToYaml`'s
   `settings` block emits only `default_profile` and `govee_devices`. **This is
   a live bug in export today**, independent of backup — anyone treating the
   YAML as a full config document is already losing these three.
4. **`importedFrom`.** The hash of the last imported `profiles.yaml`. Restore a
   bundle without it and the next start sees profiles present (so the new guard
   passes) but the hash not matching — and re-imports `profiles.yaml` straight
   over the restore. A restore that undoes itself on the next restart is the
   worst failure mode available here, so the bundle must carry this field.

Not captured, deliberately: `needsWheelbaseSetup` (derived), `govee-cache.json`
(a cache, refetched), `moza-standins/` (generated), `state.json` (which profile
is active now, not configuration).

## Decision: two artifacts, not one

Conflating "a config document I can commit" with "a snapshot that restores me
exactly" is what produced gap 2. They stay separate and are labelled as such.

**`.yaml` — Export config.** Unchanged in purpose. Human-readable, editable,
safe to commit, no secrets. Gains the three missing hardware toggles (gap 3).
The existing textarea and Copy button stay; a Download button is added.

**`.json` — Backup.** A complete bundle that restores to an identical state.
Single file, no new dependency, drag-and-droppable, avatars base64-inlined.

```jsonc
{
  "kind": "rig-profiles-backup",
  "version": 1,
  "savedAt": "2026-09-03T00:09:35.761Z",
  "app": { "plugin": "com.rig.profiles", "version": "1.4.0" },
  "containsSecrets": true,
  "settings": { /* the global settings blob, verbatim, incl. importedFrom */ },
  "avatars": { "brian.png": "data:image/png;base64,..." }
}
```

`kind` and `version` exist so a dropped file can be rejected with a sentence
that says why, rather than a stack trace. `containsSecrets` drives the warning
on both download and restore.

Avatars are profile pictures — tens of KB. Base64 inlining is worth the ~33%
overhead to keep the artifact a single file that survives being emailed to
yourself.

## The four features

### 1. Manual backup — download from the editor

The Export pane gains two buttons beside Copy:

- **Download YAML** — `rig-profiles-2026-09-03.yaml`. No secrets.
- **Download backup** — `rig-backup-2026-09-03.json`. Everything, with a line
  under it reading *"Includes your Govee API key. Keep it somewhere private."*

Both are `Blob` + `URL.createObjectURL` in the editor page, which is a real
browser tab on `127.0.0.1`, so the download needs no plugin round trip beyond
fetching the content.

New PI request: `exportBackup` → `{ bundle }`.

### 2. Automatic backup — behind the scenes

Already half-built. See **Cadence** below for the change.

The Settings pane gains a read-only row naming the location:

> **Backups** `%APPDATA%\com.rig.profiles\`
> Last backup: 2 minutes ago · 14 earlier versions kept

No browser, per the ask. The path is selectable text so it can be pasted into
Explorer. A **Reveal** button is possible — the editor server can shell out to
`explorer.exe` — but it is a new shell-out for cosmetic gain, so it is left out
unless asked for.

New PI request: `getBackupStatus` → `{ dir, lastSavedAt, generationCount }`.

### 3. Automatic restore — offer, not just act

Two paths, split by how ambiguous the situation is.

**Startup, unambiguous.** Store completely empty, marker present, mirror
healthy: restore immediately and toast. This is today's behaviour and it stays.
The deck has to work for a child at the rig when nobody is going to open an
editor, and an empty deck is strictly worse than a restored one.

**Editor, everything else.** On load, the editor asks whether the current state
looks degraded — no profiles, or fewer than the newest generation holds — and
if so shows a banner above everything:

> ⚠ **This looks like it lost data.** The newest backup is from
> **2 September, 8:09 pm** and has **4 profiles and 3 Modes**; you currently
> have **2 profiles**. [Restore it] [Dismiss]

Dated, counted, dismissible. Restoring takes a checkpoint of the current state
first, so an unwanted restore is itself undoable.

Below that, always available and not only after a disaster, a **Version history**
list in Settings: each generation by date with its profile and Mode counts, and
a Restore button per row. That turns the generations that already exist into
something a person can actually reach.

New PI requests: `getBackupOffer` → `{ degraded, newest: { savedAt, profiles, modes } }`,
`listBackups`, `restoreBackup { source: 'generation', id }`.

### 4. Manual restore — upload and drag-and-drop

A drop zone in the Settings pane accepting a `.json` bundle or a `.yaml` export,
by drop or file picker. Two steps, always:

1. **Preview.** Parse, validate `kind`/`version`, and report what is in it —
   *"Backup from 2 September, 8:09 pm: 4 profiles, 3 Modes, 4 avatars, includes
   a Govee API key."* Nothing is written yet.
2. **Confirm.** Explicit button. Takes a checkpoint of current state, then
   applies.

A `.yaml` file restores what a YAML can carry and says so plainly — *"This is a
config export, not a full backup: it has no avatars and no Govee key. Those will
be left as they are."* Merging rather than clearing is the right call for the
partial case.

New PI requests: `previewRestore { content }`, `restoreBackup { source: 'upload', content }`.

## Cadence — the answer to "every write seems too much"

Right, but only for half of it. The two things want opposite policies and
currently share one.

**The mirror stays every write.** `settings.backup.json` is the crash-recovery
copy and its entire job is to be current. It is about 1 KB against a local disk,
and anything less than every-write reopens exactly the window that lost the data
twice. Not negotiable.

**Generations become settle-based.** This is where the objection lands. The
editor autosaves, so one evening of editing produces dozens of near-identical
generations and burns all 20 slots in a sitting. The depth exists to survive
*time*, and per-write churn spends it in minutes — the history is at its
thinnest exactly when a week-old mistake needs finding.

So a generation is written when:

- **the config has been unchanged for 90 seconds** after a write (a timer reset
  by each write; one editing session yields one generation, taken when you stop
  typing), **or**
- **something risky is about to happen** — plugin start before anything can
  modify the store, immediately before a YAML import, immediately before any
  restore. These are free: they are moments, not streams, and they are the
  points a person most wants to step back to.

Identical content is still skipped, as now.

**Retention becomes tiered** rather than "newest 20", so the same ~20 files span
weeks instead of an afternoon:

| Tier | Keeps |
|---|---|
| Recent | every generation from the last 24 hours, up to 10 |
| Daily | the newest generation from each of the last 7 days |
| Weekly | the newest generation from each of the last 4 weeks |

Thinning runs after each write. A generation matching more than one tier is kept
once.

The net effect: an evening of editing costs one or two files instead of twenty,
and last Tuesday is still reachable next month.

## What this must not do

- **The mirror must not answer reads.** Stream Deck stays the source of truth
  during normal operation. A mirror that serves reads is a second source of
  truth and will eventually disagree with the first.
- **No restore without confirmation, except the unambiguous startup case.**
- **No restore without a checkpoint of what it replaces.**
- **A backup must never be written from a degraded blob.** Already enforced by
  `isWorthKeeping`; the new checkpoint triggers must respect it.
- **The YAML export must not gain the Govee key.** Gap 2 is fixed by adding a
  second artifact, never by weakening the first.
- **No cloud, no sync, no network.** Local files only.

## Open questions

1. **Does the unambiguous startup case stay automatic?** Recommended yes — a
   child at the rig cannot open an editor, and the toast reports it. Say so if
   you would rather every restore be confirmed, because it changes item 3.
2. **Does the bundle include the Govee key by default, or behind a checkbox?**
   Recommended default-on with a visible warning: a backup that silently omits a
   credential is a backup that fails when you need it.
3. **Is 90 seconds the right settle window?** Long enough that a burst of
   autosaves is one generation, short enough that closing the laptop right after
   an edit still captures it.
4. **Should `Reveal in Explorer` exist?** A new shell-out for convenience.
5. **Are the three hardware toggles a separate fix?** They are a live export bug
   today. Recommended: fix in this work, but they could ship immediately as a
   one-line change ahead of it.

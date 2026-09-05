# Spec — Backup and restore

- **Status:** Implemented 2026-09-03; amended 2026-09-05 — see Item 3, which
  settles the empty-store case: always confirm a write, never write without
  consent, with no exception for a store that looks empty
- **Date:** 2026-09-02
- **Revised:** 2026-09-02 — secrets excluded from backups entirely; restore is
  always prompted; adds the secret-field contract that makes both structural
- **Prompted by:** the second total loss of global settings, `docs/BACKLOG.md` §8

## Delivered

| Step | State |
|---|---|
| 1. `type: 'secret'`, secrets.json, key migrated out of settings | Shipped |
| 2. `settingsSchema()`, three hardware toggles declared, export gap closed | Shipped |
| 3. Bundle format, download buttons, upload + drag-and-drop, preview | Shipped |
| 4. Version history, restore offer, auto-restore removed | Shipped |
| — Empty-store auto-fill, added 09-04 and removed 09-05 | Reverted — see Item 3 |
| 5. Settle-based generations, tiered retention | Shipped |

The Hardware pane still renders its fields by hand rather than from
`settingsSchema()`. The declarations drive the export, the backup and the
secret routing, which is where correctness lives; generic rendering is
cosmetic and was left alone rather than churning a pane that works.

## Why

Global settings hold every profile, Mode, avatar and key this plugin has. Stream
Deck keeps them in memory and flushes on a clean exit, so a force-kill loses
everything since the last flush. That has now happened twice.

The mirror shipped on 2026-09-02 (`settingsBackup.js`) stops the *silent* case:
the store cannot be re-seeded over any more. What it does not give anyone is a
copy they can hold, inspect, move to another machine, or roll back to a chosen
point. That is what this adds.

## What already exists

| Piece | State |
|---|---|
| `exportYaml` PI request, `profilesToYaml()` | Shipped. Read-only textarea + Copy button in the editor. |
| `settings.backup.json` + 20 generations | Shipped. Written on every settings write. |
| `recoverIfEmpty()` at startup | Shipped, and **changes here** — see item 3. |
| Any import, upload, or UI restore | **Does not exist.** Restore today means editing `config/profiles.yaml`. |

## The audit: what a YAML export does not capture

This is the answer to "make sure the backup captures it all". Four gaps.

1. **Avatar image bytes.** `profilesToYaml` emits `avatar: brian.png` — a
   filename. The image lives in `%APPDATA%\com.rig.profiles\avatars\`. Restore a
   YAML onto a clean machine and every profile references an image that is not
   there. This is the gap that made the incident's reconstruction incomplete.
2. **The Govee API key.** Excluded, and it stays excluded — from the export and
   from the backup alike. See **Secrets** below, which makes that structural
   rather than remembered.
3. **`mozaClosePitHouse`, `mozaReopenPitHouse`, `fanatecAutoStart`.** Real
   configuration, set in the Hardware pane, and `profilesToYaml`'s `settings`
   block emits only `default_profile` and `govee_devices`. **This is a live bug
   in export today**, independent of backup — anyone treating the YAML as a full
   config document is already losing these three.
4. **`importedFrom`.** The hash of the last imported `profiles.yaml`. Restore a
   bundle without it and the next start sees profiles present (so the new guard
   passes) but the hash not matching — and re-imports `profiles.yaml` straight
   over the restore. A restore that undoes itself on the next restart is the
   worst failure available here, so the bundle must carry this field.

Not captured, deliberately: `needsWheelbaseSetup` (derived), `govee-cache.json`
(a cache, refetched), `moza-standins/` (generated), `state.json` (which profile
is active now, not configuration).

## Secrets

**A backup in the wrong hands must not contain a credential.** That is the rule,
and the design has to make it true by construction rather than by remembering.

### How it works today

The Govee API key is not provider config at all. It is a hardcoded special case
in global settings whose secrecy is hand-implemented in four separate places:

| Where | What it does by hand |
|---|---|
| `piBridge.js` `getSettings` | strips the value, substitutes `goveeApiKeySet` |
| `piBridge.js` `saveSettings` | "empty means leave alone", so saving another field cannot clear it |
| `editor.html` ~2051, ~2768 | hardcoded `type=password`, `•••••••• (saved)` placeholder, reveal toggle |
| `profilesToYaml` | omits it — because someone remembered to |

Provider `schema()` offers `select`, `range`, `boolean`, `textarea`, `text`.
Nothing marks a field sensitive. A provider added tomorrow with an API key
leaks into the export by default, and the only thing between the Govee key and
the YAML today is a comment. That is the fragility worth fixing now, while
there is exactly one secret to migrate.

### Decision 1 — providers declare `type: 'secret'`

A sixth field type in the schema contract. Declaring it buys, in one place,
everything that is currently written out four times:

- the editor renders a masked input with a reveal toggle and a
  `•••••••• (saved)` placeholder;
- the value is **never echoed back to the page** — the page receives only
  `{ key, isSet: true }`;
- an empty submitted value means *leave it alone*, never *clear it*; clearing
  is a distinct explicit action;
- it is routed to the secret store rather than the config blob;
- it cannot reach an export, a backup, or a log, because it is not in the
  object those serialise.

Single-line only. A multi-line secret (a private key) would want
`type: 'secret-textarea'`; deferred until something needs it.

### Decision 2 — secrets live outside global settings

Redacting on the way out would leave the guarantee only as strong as the
redactor, and every future code path that serialises settings — an export, a
debug dump, a log line — would have to remember. That is precisely the class of
failure this whole document exists because of.

So secrets never enter the global settings blob at all:

```
%APPDATA%\com.rig.profiles\secrets.json      { "govee.apiKey": "..." }
```

The backup mirrors global settings verbatim and **cannot** contain a secret,
because there is not one there to omit.

This has a second benefit that falls out for free: `secrets.json` is on disk and
was never in Stream Deck's memory, so it is **immune to the exact failure that
lost everything else**. A force-kill takes the profiles; the key is still there
when the plugin comes back. The one credential in the system is the one piece of
state that was already safe, once it stops living in the wrong place.

File permissions are the OS default for `%APPDATA%`, which is per-user. This is
not a secrets vault and does not pretend to be — it is a credential kept out of
documents that travel.

### Decision 3 — installation-wide provider settings become a declared thing

The Govee key is per-*installation*, not per-profile, which is why it ended up
in global settings by hand. Providers gain an optional `settingsSchema()`
alongside `schema()`: the same field shapes, but rendered in the Hardware pane
and stored once rather than per profile. `govee.apiKey` becomes the first
entry, replacing its bespoke handling; `mozaClosePitHouse`, `mozaReopenPitHouse`
and `fanatecAutoStart` are the obvious next migrations, which also closes gap 3
generically instead of by adding three more names to a list.

### What a bundle says about what it left out

```jsonc
"secretsOmitted": [
  { "key": "govee.apiKey", "label": "Govee API key", "wasSet": true }
]
```

Names and labels only, never values. This is what lets a restore say *"Restored.
Re-enter your Govee API key in Hardware settings to bring the lights back"*
instead of leaving someone to discover it when a profile half-applies.

## Decision: two artifacts, not one

**`.yaml` — Export config.** Human-readable, editable, safe to commit. Gains the
three missing hardware toggles (gap 3). The existing textarea and Copy button
stay; a Download button is added.

**`.json` — Backup.** A complete snapshot of everything that is *not* a secret:
profiles, Modes, settings, `importedFrom`, and avatars inlined. Single file, no
new dependency, drag-and-droppable.

```jsonc
{
  "kind": "rig-profiles-backup",
  "version": 1,
  "savedAt": "2026-09-03T00:09:35.761Z",
  "app": { "plugin": "com.rig.profiles", "version": "1.4.0" },
  "settings": { /* global settings verbatim, incl. importedFrom */ },
  "avatars": { "brian.png": "data:image/png;base64,..." },
  "secretsOmitted": [ /* names and labels only */ ]
}
```

`kind` and `version` exist so a dropped file can be rejected with a sentence
that says why, rather than a stack trace.

Avatars are profile pictures — tens of KB. Base64 inlining is worth the ~33%
overhead to keep the artifact a single file that survives being emailed to
yourself.

## The four features

### 1. Manual backup — download from the editor

The Export pane gains two buttons beside Copy:

- **Download YAML** — `rig-profiles-2026-09-03.yaml`
- **Download backup** — `rig-backup-2026-09-03.json`, with a line under it
  reading *"Contains no passwords or API keys. After restoring on a new
  machine, re-enter them in Hardware settings."*

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

### 3. Automatic restore — always prompted, without exception

**`recoverIfEmpty()` stops writing.** It becomes `assessStore()`: it detects the
condition, logs it, fires a toast pointing at the editor, and writes nothing.
Nothing overwrites configuration without being asked.

**This holds even when the store is completely empty.** That case was argued
both ways and settled on 2026-09-05:

> **The rule is: always confirm a write, never write without consent.**

The counter-argument was that filling an empty store overwrites nothing, so it
breaks no promise — and that after a reboot the alternative is a deck that stays
broken until an adult opens a browser, which a child at the rig cannot do. It
was implemented that way on 2026-09-04 during the third data-loss incident, and
then removed.

The reason it was removed is worth keeping: *"there was nothing there anyway"* is
the plugin deciding, on the user's behalf, what counts as data. That judgement is
exactly what went wrong three times — the seed importer also believed an empty
store meant nothing was at stake. A rule with an exception for "obviously safe"
cases is not a rule, and this codebase has now demonstrated twice that the
plugin's idea of obviously safe was wrong.

The cost is accepted deliberately: after a loss the deck shows broken keys until
someone opens the editor and confirms. A broken deck is visible and recoverable.
An unasked-for write is neither.

The failure path is therefore the ordinary one. Broken or missing keys on the
deck are themselves the prompt; opening the editor puts the offer, dated and
counted, at the top of the screen.

> ⚠ **This looks like it lost data.** The newest backup is from
> **2 September, 8:09 pm** and has **4 profiles and 3 Modes**; you currently
> have **none**. [Restore it] [Dismiss]

Dated, counted, dismissible. Restoring takes a checkpoint of the current state
first, so an unwanted restore is itself undoable.

The offer names the **richest** copy available, not the newest. On 2026-09-04 the
newest generation was a startup snapshot taken moments after a loss, so an
offer keyed on recency compared two profiles against two, decided nothing was
wrong, and stayed silent while the mirror beside it held nine records.

Below it, always available and not only after a disaster, a **Version history**
list in Settings: each generation by date with its profile and Mode counts, and
a Restore button per row.

New PI requests: `getBackupOffer` → `{ degraded, have, haveModes, newest }`,
`listBackups`, `restoreBackup { source: 'generation' | 'mirror' | 'upload', id, content }`.

### 4. Manual restore — upload and drag-and-drop

A drop zone in the Settings pane accepting a `.json` bundle or a `.yaml` export,
by drop or file picker. Two steps, always:

1. **Preview.** Parse, validate `kind`/`version`, and report what is in it —
   *"Backup from 2 September, 8:09 pm: 4 profiles, 3 Modes, 4 avatars. No
   secrets; you will re-enter the Govee API key."* Nothing is written yet.
2. **Confirm.** Explicit button. Takes a checkpoint of current state, then
   applies.

**A restore never touches `secrets.json`.** Whatever is already on the machine
stays, which is right in both directions: restoring on the same machine keeps
the lights working, and restoring someone else's backup cannot plant a
credential.

A `.yaml` file restores what a YAML can carry and says so plainly — *"This is a
config export, not a full backup: it has no avatars. Those will be left as they
are."* Merging rather than clearing is the right call for the partial case.

New PI requests: `previewRestore { content }`, `restoreBackup { source: 'upload', content }`.

## Cadence — the answer to "every write seems too much"

Right, but only for half of it. The two things want opposite policies and
currently share one.

**The mirror stays every write.** `settings.backup.json` is the crash-recovery
copy and its entire job is to be current. It is about 1 KB against a local disk,
and anything less than every-write reopens exactly the window that lost the data
twice. Not negotiable.

**Generations become settle-based.** This is where the objection lands. The
editor autosaves, so one evening produces dozens of near-identical generations
and burns all 20 slots in a sitting. The depth exists to survive *time*, and
per-write churn spends it in minutes — the history is at its thinnest exactly
when a week-old mistake needs finding.

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

- **No secret in any artifact that leaves the machine.** Enforced by keeping
  secrets out of the object those artifacts serialise, not by filtering.
- **No restore without confirmation.** Including at startup.
- **No restore without a checkpoint of what it replaces.**
- **A restore must not write, clear, or carry secrets.**
- **The mirror must not answer reads.** Stream Deck stays the source of truth
  during normal operation. A mirror that serves reads is a second source of
  truth and will eventually disagree with the first.
- **A backup must never be written from a degraded blob.** Already enforced by
  `isWorthKeeping`; the new checkpoint triggers must respect it.
- **No cloud, no sync, no network.** Local files only.

## Sequencing

The secret work gates the backup work, because a bundle cannot promise "no
credentials" while credentials still live in the blob it copies. Suggested
order:

1. `type: 'secret'` + `secrets.json` + migrate `govee.apiKey` out of global
   settings. Nothing user-visible changes; the Hardware pane keeps working.
2. `settingsSchema()`, moving the three hardware toggles onto it. Closes gap 3.
3. Bundle format, download buttons, upload and preview.
4. Version history, the restore offer, and the removal of auto-restore.
5. Settle-based generations and tiered retention.

Steps 1 and 2 are worth doing even if the rest is deferred: they fix a live
export bug and remove a leak that is currently prevented only by a comment.

## Open questions

1. ~~Does the unambiguous startup case stay automatic?~~ **Resolved: no.**
   Always prompted, per the transition note in item 3.
2. ~~Does the bundle include the Govee key?~~ **Resolved: never**, and made
   structural by Decisions 1–3.
3. ~~Is `type: 'secret'` the right shape, or `secret: true` on an existing
   type?~~ **Resolved: the type.** One obvious rendering, one obvious storage
   route. A multi-line secret gets its own type if something ever needs one.
4. ~~Is 90 seconds the right settle window?~~ **Resolved: yes.**
5. ~~Should `Reveal in Explorer` exist?~~ **Resolved: no.** The path as
   selectable text is enough; not worth a new shell-out.
6. ~~Does `secrets.json` need at-rest protection?~~ **Resolved: no.** It is a
   lighting API key and `%APPDATA%` is already per-user. Revisit only if a
   provider ever wants something that matters more.

# Playnite on the Stream Deck — handoff

A separate Stream Deck plugin, in its own repository, that puts a Playnite
library on the deck: real games, real artwork, collections as folders, and
launch variants as a first-class idea rather than a per-game hack.

This document exists so a fresh session does not re-derive what was established
on 2026-08-29/30. Everything under "Verified" was checked against the real
install on this machine; everything under "Open" was not.

---

## 1. What this is for

Today Brian reaches his library from the deck by exporting shortcuts to a
folder, pointing deck buttons at them, and copying artwork out of Playnite by
hand to apply per key. It works and it is miserable to maintain.

Wanted, in his order:

- Games on the deck **with their Playnite artwork**, automatically.
- **Collections as folders**, using the categories he already curates in
  Playnite.
- **Launch variants** — specifically VR — as a first-class feature, not a
  global launcher script or per-game workarounds.

### Why it matters more than it used to

He moved from a Quest to a **Pimax on DisplayPort**. On the Quest he could see
the desktop inside the headset, launch a game from it, and never take the
headset off. With a DP headset that workflow is gone: the desktop and the
OpenXR runtime are different worlds, and launching an OpenXR title from a
desktop view inside the headset is, in his words, a disaster.

So the deck becomes the launcher of last resort. It has to be usable **while
wearing a headset you cannot see past**, which means artwork must be
recognisable at a glance before you put it on, and launching must land straight
in VR with no desktop interaction afterwards.

That reframes the plugin from "a nice library browser" into "the only usable
input surface once the headset is on". But note his own correction: **the
plugin is worth building without any of the VR story.** Do not let VR drive the
architecture.

---

## 2. Verified facts about the Playnite install

Checked 2026-08-30 on this machine. Playnite was running throughout, which is
the state that matters — it must be running to launch anything.

| Fact | Detail |
|---|---|
| Install | Portable, `D:\Apps\Playnite\Playnite.DesktopApp.exe` |
| Library | `D:\Apps\Playnite\library` — **not** under `%APPDATA%` |
| Database version | `database.json` → `{"Version":4}` |
| Per-entity files | `games.db`, `categories.db`, `platforms.db`, `tags.db`, `features.db`, … (LiteDB) |
| **`games.db` while Playnite runs** | **Exclusively locked. Cannot be read OR copied** — `cp` fails with "Device or resource busy" |
| Artwork | `library/files/<guid>/*.jpg|*.ico` — **not locked**, copies fine while Playnite runs |
| Artwork volume | ~60 game folders at time of writing |
| URI scheme | `playnite://` **is registered** → `"D:\Apps\Playnite\Playnite.DesktopApp.exe" --uridata "%1"` |
| Extensions present | Steam/Epic/GOG/Origin/Xbox/Rockstar libraries, IGDB metadata, DuplicateHider, HowLongToBeat — **none expose an API** |

### The lock decides the architecture

Playnite must be running to launch a game, and while it runs nothing else can
read its library. Therefore:

> **A Playnite extension is not optional.** It is the only thing that can see
> the library at runtime.

Do not spend time on LiteDB readers for Node. That path is closed.

---

## 3. Architecture

```
Playnite extension  ──writes──▶  library snapshot (games, collections, actions)
                                          │
                                          ▼
Stream Deck plugin  ──reads──▶  snapshot + artwork straight off disk
                    ──asks───▶  extension to launch <game, action>
```

This mirrors what already works between `streamdeck-rig-profiles` and
`streamdeck-ac-launcher`: a file with a documented schema, written atomically,
with neither side importing the other.

**The extension is both exporter and launcher.** The URI scheme starts a game's
*default* action; it has no vocabulary for "start this game's VR action". So
launch variants have to go through the extension anyway, which is what makes
them first-class rather than a launch-argument hack.

Artwork does **not** need to pass through the extension — it is unlocked on
disk, and the snapshot need only carry paths.

---

## 4. The VR flag, and where that logic belongs

`streamdeck-rig-profiles` now has a **Mode** primitive and a **Rig State Flag**
provider that writes named boolean flags to:

```
%APPDATA%\streamdeck-rig-shared\rig-flags.json
{ "version": 1, "flags": { "vr": true }, "updated": "<ISO-8601>" }
```

Written atomically (temp file then rename), so a reader never sees a half
document. A missing file means no flags — not an error.

**Neither program knows the other exists.** The rig plugin writes the file
because a Mode was switched on; anything at all may read it; a batch file
writing the same JSON works identically. That was a deliberate design decision
by Brian, and it is the reason this integration does not couple the two
plugins. Preserve it.

### Brian's own refinement, and it is probably right

> *"I'm thinking this particular detail may just work as a Playnite extension
> rather than routing through the plugin on the deck."*

Agreed, and worth stating clearly for whoever builds this: **if the extension
reads the flag, VR launching works no matter how the game was started** — from
the deck, from Playnite's own UI, from a desktop shortcut. If the deck plugin
owns that decision instead, it only works for launches that go through the
deck.

So the recommended split is:

- **Extension**: reads `rig-flags.json`, and when `flags.vr` is true prefers a
  game's VR play action (or applies VR arguments). Also exports the snapshot
  and performs launches.
- **Deck plugin**: renders keys, folders, artwork; asks the extension to launch
  a game. It may *display* VR state as a convenience, but must not be the thing
  that decides.

That keeps the deck plugin useful with no VR story at all, which was the
requirement.

---

## 5. Open questions — answer these first

These were not resolved, and the first two materially change the effort.

1. **How are VR variants modelled in the library today?** A second *play
   action* on the same game, a separate game entry, or a tag/feature? If they
   are already separate play actions, the extension is *picking* one and the
   work is small. If not, something has to synthesise arguments per game, which
   is a much larger and less reliable job. Brian's first thought was passing
   `-vr` or similar, and he believed Playnite holds metadata identifying which
   games support VR — he intended to look for it.
2. **Which collections should become folders, and how large are they?** Drives
   whether folders need paging.
3. **How does the extension expose itself?** A file the deck plugin polls, a
   local HTTP endpoint, or a named pipe. The file approach matches the existing
   precedent and needs no port management; HTTP is nicer for request/response
   launching. Probably: file for the snapshot, something request/response for
   launching.
4. **Extension language.** Playnite extensions are C# or PowerShell. The C# SDK
   is the documented path; PowerShell is lighter but more limited.

---

## 6. Lessons from building the rig-profiles plugin

Hard-won on this machine. Most cost real time.

### Stream Deck

- **Two different reloads.** Killing the plugin's node process reloads its
  *code*. It does **not** make Stream Deck re-read `manifest.json` — the action
  list, names and UUIDs are cached by the app. Manifest changes need the
  **Stream Deck application** restarted.
- **`npx streamdeck restart <uuid>` reported success while doing nothing**, for
  an entire evening. Always verify by process start time:
  ```
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*<your-plugin>*' } |
    Select-Object ProcessId, CreationDate
  ```
- **Changing an action's UUID orphans placed keys.** Users must re-add them.
- **`npx streamdeck validate <dir>` is a useful pre-flight**, but insists the
  directory be named `<uuid>.sdPlugin`, so validate a staging copy. It caught a
  real error (`Version` needs four parts: `1.0.0.0`).
- **Packing** needs the same directory name and refuses a symlink. Install
  production dependencies only: a straight `node_modules` copy shipped vitest,
  75.1 MiB against 21.7 MiB. See `docs/RELEASING.md`.
- **There is no action-composition API in either direction.** A plugin cannot
  enumerate, invoke, or embed another plugin's action; Multi Actions have no
  addressable identity. The complete command vocabulary is small and contains
  no `triggerAction`. The `Hotkey` action *sends* keystrokes; nothing in
  Stream Deck listens for one to trigger a key.
- **Deep links are inbound only**: `streamdeck://plugins/message/<UUID>/<msg>`
  delivers to a plugin that implements `onDidReceiveDeepLink`. Nothing on this
  machine implements one. Useful for letting *others* trigger *you*.
- **Actions inside a Multi Action have no coordinates**, so `setImage` has
  nothing to target, and `keyDown`/`keyUp` arrive back to back — which silently
  disables any hold gesture.
- **`sendToPlugin` is delivered to the action it came from**, not to the plugin
  at large. Every action with a property inspector needs its own
  `onSendToPlugin`, or its panel hangs until it times out.
- Stream Deck ships its **own Node** (20.20.0 here) — not the one on PATH.
  Smoke-test imports with it. N-API native modules are ABI-stable, so
  `serialport` works across both; ABI-locked ones would not.

### Design principles that kept paying off

- **Never claim success you cannot confirm.** A status vocabulary that
  distinguishes verified / applied-unverified / mismatch / unreachable is worth
  the effort when a child's safety setting is downstream.
- **The component with the information owns the judgement.** Outcome reporting,
  context declarations, and state reporting all started in the core and all
  belonged in the providers. Every time this was fixed, the code got smaller.
- **Validation must not depend on mutable external state.** Treating "does this
  preset still exist?" as a validation error meant one stale reference blocked
  saving *everything*, with no way to fix it in the UI. Structural validity and
  environmental availability are different questions.
- **An alarm that always fires is not an alarm.** A provider that can never
  report success made every switch look failed until the distinction was drawn.
- **Test the property, not the literal.** Tests asserting exact hex colours and
  exact wire values had to be rewritten every time a design choice moved; one
  test had even enshrined a wrap-around bug as correct behaviour.
- **Verify writes by reading back**, on anything hardware. Acknowledgements lie.

---

## 7. Suggested first session

```
Read docs/PLAYNITE-PLUGIN.md in streamdeck-rig-profiles for context, then:

1. Answer open question 1 by inspecting the Playnite library — you will need
   Playnite CLOSED to read games.db, since it holds an exclusive lock while
   running. Determine how VR variants are modelled: separate play actions,
   separate entries, or tags.
2. Prototype the Playnite extension that exports a snapshot of games,
   collections and play actions, plus artwork paths.
3. Only then start the Stream Deck plugin.

Do not attempt to read games.db from the deck plugin at runtime. It is locked
whenever Playnite is running, and Playnite must be running to launch anything.
```

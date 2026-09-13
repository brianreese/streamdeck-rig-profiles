# Spike 01 — can a rig profile change the Stream Deck's screensaver?

- **Status:** Complete — **no**, by any supported route
- **Date:** 2026-09-13
- **Question:** Brian is a Red Bull fan and has a Red Bull Racing screensaver on
  the deck. His son is a McLaren fan. When Kai's profile is applied and the
  screensaver later fires, can it be his team's?
- **Method:** read what the SDK exposes, then find where the setting is actually
  stored and at what scope. Three doors, each shut independently — the third is
  the one that decides it.
- **Effort:** bounded at "find the setting or conclude it is not reachable". The
  setting was never found in any readable form, and that is the finding.

## Door 1 — there is no API

Nothing in `@elgato/streamdeck/dist` matches `screensaver` in any casing. The
device-facing surface a plugin gets is:

```
switchToProfile   setImage   setTitle   openUrl   onDidReceiveDeepLink
```

A plugin cannot set it, read it, or be told it changed.

## Door 2 — it is not a profile property either

This is the one that kills the obvious workaround. `switchToProfile` is the only
lever a plugin has over what the deck looks like at rest, so if a *profile*
carried a screensaver, the feature would be a small provider: give Kai a McLaren
profile, switch to it, done.

It does not. A `.sdProfile/manifest.json` has exactly:

```
Device   InstalledByPluginUUID   Name   Pages   PreconfiguredName   ReadOnly   Version
```

No screensaver, no wallpaper, no idle image. Switching profiles changes the keys
and nothing else.

## Door 3 — it is per-device app state, in an opaque blob

Searched for it and did not find it in any readable form:

- No file under `%APPDATA%\Elgato` or `%LOCALAPPDATA%\Elgato` mentions
  screensaver, except `Marketplace\cache.json`, which is catalogue metadata about
  screensaver *products* rather than a setting.
- `Assets\` holds exactly one PNG, 39 KB, named with a Marketplace id
  (`7M6GVOLSOT1N7AIFKS4CD55G2GZ.png`) — almost certainly the Red Bull image.
- **That asset id appears in no text file anywhere in the tree.** Whatever links
  device to image is not stored as text.
- `HKCU\Software\Elgato Systems GmbH\StreamDeck` holds ~27 KB of Qt-serialised
  `REG_BINARY`, including a `Devices` value whose decoded prefix reads
  `DeviceName`, `Stream Deck`, `ESDProfilesInfo`, `map_dev_brightness`,
  `map_dev_enabled`. That is where per-device settings live.

So the setting is **per device**, not per profile, in a binary blob owned by a
running application.

## Conclusion

Not achievable. The only mechanism would be rewriting that registry blob and
forcing the app to re-read it: undocumented, unversioned, and contending with a
process that owns the same key and will rewrite it from memory. On a rig a child
uses, a corrupt device-settings blob is a much worse outcome than the wrong
livery on a screensaver.

## What would reopen this

- **A screensaver field appearing in `.sdProfile/manifest.json`.** Then it is a
  provider that calls `switchToProfile`, and the existing Stream Deck profile
  machinery already covers it. Worth re-checking on any major Stream Deck
  release; it is a one-key check against the manifest keys listed above.
- **An SDK API.** Grep `@elgato/streamdeck/dist` for `screensaver` after any SDK
  bump; this spike is two minutes to redo.
- Elgato answering directly that one is planned.

## Not investigated

Whether the Stream Deck **software** can switch screensavers on a schedule or a
hotkey independently of this plugin. If it can, a Multi Action or a macro might
reach it even though a plugin's API cannot — that is a different question with a
different answer, and nobody has asked it yet.

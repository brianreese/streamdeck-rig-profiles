# MOZA support (experimental)

MOZA presets cannot be applied directly. The official SDK's entire pedal
surface is seven output settings, while an mBooster preset carries ~91
parameters, and the device serial protocol has not been reverse engineered
(see `docs/BACKLOG.md` §6).

What works instead is Pit House's own game binding. Pit House watches for a
fixed set of game executables and applies whichever preset you bound to that
game. It matches on process **name** alone, so a harmless stand-in process is
enough, and the applied preset survives the process exiting.

    profile switch  ->  run a fake game  ->  Pit House applies the preset

## Files

| File | Role |
|---|---|
| `presetStore.js` | Reads Pit House's preset library and `config.ini` |
| `standIn.js` | Runs a short-lived process with a chosen executable name |

## Setup

1. In Pit House, bind the preset to a game you will never launch, then use
   **Set as Game Default Preset**.
2. Put that game's executable name in the provider's Trigger field.

The second half of step 1 is the part that matters. Many presets can be bound
to the same game — 44 ship bound to Assetto Corsa — and Pit House applies
whichever is that game's *default*, not whichever you bound most recently. It
warns when you replace an existing default, so the slot is explicitly
single-occupancy.

The game list is compiled into Pit House's binary and cannot be extended —
editing `GameConfigInfo.xml` has no effect, which was tested. So the trigger
must be a name Pit House already knows.

## Known rough edges

- Naming a profile after an unrelated game is poor UX. A custom trigger name
  would fix it and is the main thing worth revisiting.
- Pit House must be running.
- If you ever genuinely launch the sacrificed game, its preset applies.

## Hard limitation: no game may be running

Tested directly. While **any** game Pit House knows is running, it ignores
further game starts for preset purposes — the trigger is silently dropped.

```
start : Brian Brake Hybrid
1. launching iRacingSim64DX11.exe   -> iRacing-Brake-SebOne   (its default applied)
2. launching AssettoCorsa.exe       -> unchanged              (trigger ignored)
3. trigger exits                    -> unchanged
4. game exits                       -> unchanged
```

The same held with an *unbound* game running (Wreckfest), so it is not "the
first game wins its preset" — it is "a running game blocks any further switch".

### What this means in practice

- **Switch the profile, then launch the game.** Mid-session switching does not
  work at all.
- **The games you actually play must have no default preset**, or launching one
  overrides the profile you just applied. A game with nothing bound to it was
  confirmed to leave the pedal untouched.
- Nothing reverts on exit, so once applied the profile persists.

`verify()` catches the mid-session case and reports a mismatch, so a key never
claims success over an unchanged pedal.

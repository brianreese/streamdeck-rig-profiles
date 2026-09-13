# Spike 02 — which providers should a given rig even see?

- **Status:** Open — options recorded, decision pending. **Release blocking.**
- **Date:** 2026-09-13
- **Question:** Every provider this plugin ships is offered to every user. Some
  depend on another Stream Deck plugin being installed; some depend on hardware
  or a service the user does not own; most users will want a minority of them.
  What decides whether a provider appears?
- **Method:** establish what is actually detectable at runtime, then record the
  options rather than pick one. Nothing is built yet, deliberately — the two
  halves below may be one mechanism or two, and that is the decision.

## Why this is release blocking

This plugin is going to a wider audience. Today:

- **`ace-driver` hardcodes another plugin's identity.** It sends a deep link to
  `com.race.launcher`. If that plugin is not installed, the provider still
  appears in the editor, still validates, still reports *applied-unverified*, and
  does nothing. A deep link has no reply, so it cannot even notice. Brian: *"I
  won't release with the hardcoded racelauncher stuff that will look broken."*
- **Govee is in the list for everybody.** A user on Philips Hue sees a provider
  they cannot use, next to the one they want, which does not exist yet. Most
  users will want neither.

Both are the same shape of problem — *this is not for you* — and neither is
currently expressible.

## What is established

**Sibling plugins are trivially discoverable.** The plugin runs from
`Plugins\com.rig.profiles.sdPlugin\`, so its siblings are two directories up.
Verified on this machine:

```
plugins dir: C:\Users\brian\AppData\Roaming\Elgato\StreamDeck\Plugins
siblings   : 6
race launcher installed? true
playnite installed?      true
```

Each `*.sdPlugin/manifest.json` yields a `UUID` and a `Name` — enough to say
*"requires Race Launcher (not installed)"* in words a person recognises.

**Installed is not running is not working.** Detection upgrades the failure from
silent to *"we can see it is not installed"*. It cannot tell you the target is
alive, because the deep link still has no reply. That limit is inherent and
should be stated wherever this lands, not discovered later.

## Option A — the provider declares a requirement

`requiresPlugin: 'com.race.launcher'`. The registry checks the Plugins directory;
the editor greys the block with the reason.

Fits the existing declaration pattern exactly — `contexts`, `repeatable`,
`settingsSchema()`, `type: 'secret'` are all providers declaring things about
themselves that the core reads without knowing what they mean.

- **For:** small, honest, no coordination with anyone.
- **Against:** only answers the *other plugin* case. Says nothing about Govee vs
  Hue, where nothing is installed to detect.

## Option B — plugins advertise capabilities to rig-profiles

A convention — a `rig-profiles.json` sidecar in a plugin's directory — that this
plugin scans, so a provider is offered because something declared it.

- **For:** the only version that scales past plugins we already know about.
- **Against:** a scanned file written by another author is untrusted input, and
  this is a large design (schema, versioning, what a declaration may assert).

## Option A/B hybrid — Brian's refinement, and the one to design against

> *"Untrusted, sure, but it's only a flag. The plugin's json can't define a new
> plugin. The provider implementation in our plugin MUST point to
> com.race.launcher for us to consider the json file from com.race.launcher."*

This collapses most of B's trust problem. The **provider is still written here**,
in this repository, and names the plugin it depends on. The sidecar file is only
ever consulted **for the plugin a provider already named**, and all it can do is
confirm. It cannot introduce a provider, cannot change what a provider does, and
cannot be read at all for a plugin no provider mentions.

So the trust surface is one boolean from a known source, which is a very
different thing from "scan the machine and build a feature list".

Open within this option:

- **What does the sidecar add over the directory existing?** If "installed" is
  all we need, A is enough on its own. The sidecar earns its place only if it
  says something the filesystem cannot — a capability version, or *"the driver
  feature is present in this build"*.
- **What happens when the file is absent?** A plugin that predates the convention
  is installed and working; treating "no sidecar" as "not capable" would break
  `ace-driver` against today's Race Launcher, which is installed and working.
  Absent probably has to mean *assume capable*, which weakens the file further.

## The other half — enabling and disabling providers by hand

Brian: *"what if a user uses Philips Hue instead of Govee. Both providers can and
should exist side by side. One is irrelevant. Many users will have no use for
either."*

Nothing detectable distinguishes these. There is no Govee plugin to find; the
provider talks to a cloud API with a key the user pastes. The signal is **the
user's intent**, and the only source of it is the user.

Sketch: a Settings pane listing every provider with a search box and a toggle.
Disabled providers do not appear in "Add to this profile".

Undecided, and the reason this is one spike rather than two:

- **Does manual enablement replace detection, or sit under it?** A single list of
  toggles where the requirement check merely pre-sets a default is one mechanism
  instead of two, and a user who knows better can override it.
- **What is the default for a fresh install?** All on is today's behaviour and is
  the thing being complained about. All off means an empty editor and a bad first
  run. A middle position — on unless a declared requirement is unmet — is
  probably right and is exactly the hybrid above.
- **What happens to a profile that uses a disabled provider?** This one is
  already decided by precedent and should not be re-litigated: unknown provider
  config is **kept and shown greyed, never dropped**, because config outlives
  code. A disabled provider must behave the same way, or disabling Govee silently
  destroys four profiles' lighting.

## What this spike does not settle

Which of the two mechanisms ships first, and whether they are one. Brian: *"Maybe
this works with the A/B hybrid above, maybe it replaces. We can decide later."*

The release gate is that **a provider the user cannot possibly use must not look
broken** — by either route.

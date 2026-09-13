# Spikes — streamdeck-rig-profiles

Investigations that answer a question. A spike is never approved, may conclude
"no", and is not promoted to a spec because it turned out well.

Same convention as `openlap/docs/spikes` and `streamdeck-race-launcher/docs`.

| # | Question | Status |
|---|---|---|
| [01](01-screensaver-per-profile.md) | Can a rig profile change the deck's screensaver? | **Complete — no** |
| [02](02-provider-discovery-and-enablement.md) | Which providers should a given rig even see? | **Open — release blocking** |

## Why a spike rather than a spec

Global ADR-0001 requires a reviewed spec before implementation, and exempts
spikes for a reason that applies to both of these: *"Some questions cannot be
answered by reading anything. Writing a spec around one produces
confident-looking prose that is wrong."*

**01 is the pure case.** The question was whether an API exists. No amount of
design would have answered it, and the answer turned out to be no — which is a
result worth keeping precisely because it stops the next person spending an
afternoon on it. Its value is entirely in the three doors and the two triggers
that would reopen them.

**02 is the other kind**, and closer to spike 08 in openlap: it tests a *design*
rather than a fact. What it establishes by investigation is narrow — that sibling
plugins are detectable, and that detection can never mean "working". Everything
else in it is options, recorded unbuilt, because the decision is Brian's and the
two halves may turn out to be one mechanism.

## A note on negative results

01 found nothing and is the more useful document of the two today. The finding is
not "there is no screensaver API" — that is one grep. The finding is that the
setting is **per device, in a binary blob**, so the obvious workaround
(`switchToProfile`) does not reach it either. That second door is the one a
future attempt would otherwise walk into.

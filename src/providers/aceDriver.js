// providers/aceDriver.js — put a driver in the seat in the ACE race launcher.
//
// Applying a rig profile says who is at the rig. This tells the race launcher
// the same thing, so the assists that belong to that person are the ones in
// force when a session starts.
//
// It sends ONE deep link and hears nothing back:
//
//   streamdeck://plugins/message/com.race.launcher/activate?id=<driver profile uuid>
//
// That is the whole surface. The race launcher's ADR-0002 records why it is a
// deep link rather than the local HTTP server that was built first, and rather
// than the state file proposed after that:
//
//   ~/Development/streamdeck-race-launcher/docs/architecture/decisions/
//     adr-0002-deep-links-over-a-local-server.md
//
// ---------------------------------------------------------------------------
// Why this provider does not report an outcome
// ---------------------------------------------------------------------------
//
// There is no verify(), no isActive(), and `verifiable: false`.
//
// `openUrl` resolves once the Stream Deck app has been handed the URL. Not once
// a plugin received it, and not once anything acted on it — a deep link is a
// URI scheme, not a protocol, and there is no reply channel to wait on. If the
// race launcher is not installed, the URL goes nowhere and this call still
// succeeds. So the honest answer to "did it work" is that this provider cannot
// know, and the registry already has a word for that: a provider with no
// verify() is reported APPLIED-UNVERIFIED. `verifiable: false` additionally
// stops the profile key nagging about a status that will never improve.
//
// **This is acceptable here for exactly one reason: nothing dangerous happens
// if a driver profile fails to apply.** It does not move a wheel or a pedal. It
// changes which assists a game will read.
//
// Do not copy this shape to a provider that touches a physical peripheral. The
// mBooster provider reads the pedal back and refuses to claim success it has
// not confirmed, because a brake that silently kept the previous driver's
// settings is a child pressing a pedal set up for an adult. That difference is
// the whole reason one of these verifies and the other does not.
//
// ---------------------------------------------------------------------------
// Why there is no dropdown
// ---------------------------------------------------------------------------
//
// No options(). A deep link has no query channel, so there is nothing to ask
// for a list of driver profiles — that is the deliberate cost of having no
// server, argued in the ADR above. A person opens the race launcher's Drivers
// tab, copies the id, and pastes it here once.
//
// ---------------------------------------------------------------------------
// Why there is no unapply()
// ---------------------------------------------------------------------------
//
// A driver profile has no "off". Somebody is in the seat, or somebody else is;
// there is no third state to return to, and inventing one — clearing the seat,
// restoring whoever was there before — would be this plugin asserting something
// the race launcher never agreed to. A Mode holding this provider therefore
// contributes nothing to whether the Mode reads as active, and a long press
// leaves it alone. See modeKey.js: that is already how a provider with no
// reversible half behaves.

/** Canonical 8-4-4-4-12. The launcher mints lowercase; a paste may not be. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TARGET = 'com.race.launcher';

const clean = (raw) => String(raw ?? '').trim();

/**
 * Hand a URL to the Stream Deck app.
 *
 * The SDK is imported lazily, and only when nothing was injected, so that
 * merely loading the provider registry does not pull `@elgato/streamdeck` into
 * the module graph. configConvert.js was split out of migrate.js for exactly
 * that reason: importing the SDK opens a rotating log file as a side effect,
 * and parallel test workers then race on renaming it.
 */
async function openUrl(url, injected) {
  if (injected) return injected(url);
  const { default: streamDeck } = await import('@elgato/streamdeck');
  return streamDeck.system.openUrl(url);
}

export default {
  id: 'ace-driver',
  label: 'ACE Driver Profile',

  // See the note above: a deep link has no reply, so this provider cannot
  // honestly answer whether it worked, and must not pretend otherwise.
  verifiable: false,

  // Who is at the rig is a profile's business, and a Mode may reasonably set it
  // too — a "Kai practising" Mode is a coherent thing to want.
  contexts: ['profile', 'mode'],

  // One driver is in the seat. Two of these on one record would send two deep
  // links and the last one home would win, which is a seat nobody chose.
  repeatable: false,

  schema() {
    return [
      {
        key: 'driverId',
        label: 'Driver profile id',
        type: 'text',
        placeholder: '4a0d6d7c-e5e6-4a4a-9b0a-1f2e3d4c5b6a',
        help:
          "From the race launcher's admin UI, Drivers tab — copy the id and paste it here. "
          + 'There is no list to pick from: the two plugins talk over a one-way deep link '
          + 'with no query channel, so this is pasted once per driver.',
      },
    ];
  },

  validate(cfg) {
    const id = clean(cfg?.driverId);
    if (!id) return ['ACE driver profile needs an id'];
    if (!UUID.test(id)) {
      return ['driver profile id must be a UUID, copied from the race launcher Drivers tab'];
    }
    return [];
  },

  describe(cfg) {
    const id = clean(cfg?.driverId);
    if (!id) return 'no driver selected';
    // The id is opaque and there is no way to resolve it to a name from here,
    // so show enough to tell two apart without pretending to know who it is.
    return `driver ${id.slice(0, 8)}…`;
  },

  /**
   * Send the activation.
   *
   * Lowercased because the launcher's ids are lowercase by contract (its
   * domain/newId.ts says so, because they become filenames), and a paste that
   * picked up capitals should still find its driver rather than silently
   * activating nothing.
   */
  async apply(cfg, ctx = {}) {
    const problems = this.validate(cfg);
    if (problems.length) throw new Error(problems[0]);

    const id = clean(cfg.driverId).toLowerCase();
    const url = `streamdeck://plugins/message/${TARGET}/activate?id=${encodeURIComponent(id)}`;
    await openUrl(url, ctx.openUrl);
  },
};

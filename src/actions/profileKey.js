// actions/profileKey.js — "Rig Profile" direct action.
//
// One key bound to one profile. Press it and you get that profile; there is no
// cycling to overshoot and no current state to read first. Three keys side by
// side, one lit, is legible to someone who cannot read the labels.
//
// Restricted profiles (yours, at full torque) require a deliberate hold rather
// than a tap, so the dangerous direction cannot be reached by a stray press.
//
// Note: no `@action` decorator. The SDK's decorator does nothing but set a
// `manifestId` field, and V8 has no native decorator support — using a plain
// class field keeps this buildless, which is how the rest of the plugin runs.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { applyProfile, summarise } from '../profileSwitch.js';
import { renderProfileKey } from '../buttonRenderer.js';
import { notify } from '../notify.js';
import { STATUS, isProblem } from '../providers/index.js';
import { readState, writeState } from '../state.js';
import { loadAvatarDataUri } from '../avatars.js';
import { handlePiRequest } from '../piBridge.js';

export const MANIFEST_ID = 'com.rig.profiles.key';
export const HOLD_MS = 1000;

/**
 * Every visible key, so they all repaint together when the active profile
 * changes — pressing "Kai" must visibly extinguish "Brian".
 */
const visible = new Map(); // action.id -> { action, profileId }

let activeProfileId = null;
let activeStatus = STATUS.SKIPPED;
let hydrated = false;

/**
 * The profile mid-switch, if any.
 *
 * Applying a profile is slow — a MOZA curve alone is seven verified writes —
 * and every other key used to keep its old paint until the whole thing
 * finished, so the profile you just left stayed lit for ten seconds while the
 * one you pressed claimed to be active. Tracking the switch separately lets
 * every key repaint at once, the moment the press is accepted.
 */
let switchingProfileId = null;

/** Avatar bytes, keyed by filename. Cheap to hold, expensive to re-read. */
const avatarCache = new Map();

function findProfile(settings, id) {
  const profile = (settings?.profiles ?? []).find((p) => p.id === id) ?? null;
  if (!profile?.avatar) return profile;

  if (!avatarCache.has(profile.avatar)) {
    avatarCache.set(profile.avatar, loadAvatarDataUri(profile.avatar));
  }
  // A missing file degrades to the initial fallback rather than breaking the key.
  return { ...profile, avatarDataUri: avatarCache.get(profile.avatar) ?? undefined };
}

/**
 * The body of a success toast.
 *
 * `summarise` answers "all hardware confirmed", which is true and says nothing
 * you could act on. Naming what actually ran is the point of announcing every
 * switch — and when a provider could only be sent to rather than confirmed,
 * saying which one, because that is the difference between "your lights
 * changed" and "your lights were asked to change".
 */
function describeOutcome(outcome) {
  const ran = (outcome.results ?? []).filter((r) => r.status !== STATUS.SKIPPED);
  if (!ran.length) return 'nothing configured for this profile';

  const names = ran.map((r) => r.label).join(', ');
  const unconfirmed = ran.filter((r) => r.status === STATUS.APPLIED_UNVERIFIED).map((r) => r.label);
  return unconfirmed.length ? `${names} — ${unconfirmed.join(', ')} not confirmed` : `${names} — confirmed`;
}

async function repaintAll(settings) {
  await Promise.all(
    [...visible.values()].map(({ action, profileId }) => {
      const profile = findProfile(settings, profileId);
      // Paint unassigned keys too — leaving the manifest icon in place makes
      // an unconfigured key look identical to a working one.
      if (!profile) return action.setImage(renderProfileKey({ profile: null, active: false }));
      return action.setImage(
        renderProfileKey({
          profile,
          active: profile.id === activeProfileId,
          switching: profile.id === switchingProfileId,
          status: activeStatus,
          unknown: activeProfileId === null,
        }),
      );
    }),
  );
}

/** Repaint every key after something changed the profiles or their avatars. */
async function refreshKeys() {
  avatarCache.clear();
  await repaintAll(await streamDeck.settings.getGlobalSettings());
}

export class ProfileKey extends SingletonAction {
  manifestId = MANIFEST_ID;
  #timers = new Map();

  async onWillAppear(ev) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const profileId = ev.payload.settings?.profileId;
    visible.set(ev.action.id, { action: ev.action, profileId });
    streamDeck.logger.info(
      `[profileKey] willAppear key=${ev.action.id} profileId=${JSON.stringify(profileId)} ` +
        `knownProfiles=${(settings?.profiles ?? []).map((p) => p.id).join(',') || 'none'}`,
    );

    if (!hydrated) {
      hydrated = true;
      // Restore the last known profile so the deck is not blank after a
      // restart — but mark it unverified, because we have not talked to the
      // hardware yet this run and must not imply that we have.
      activeProfileId = readState()?.activeProfile ?? null;
      activeStatus = activeProfileId ? STATUS.APPLIED_UNVERIFIED : STATUS.SKIPPED;
    }
    await repaintAll(settings);
  }

  onWillDisappear(ev) {
    visible.delete(ev.action.id);
    this.#clear(ev.action.id);
  }

  /**
   * Keep the visible-key cache in step with the property inspector.
   *
   * Without this, a key registered at willAppear with no profile keeps that
   * stale binding for the rest of the session: pressing it works (the event
   * payload carries live settings) but every repaint afterwards falls back to
   * the unassigned image.
   */
  async onDidReceiveSettings(ev) {
    const profileId = ev.payload.settings?.profileId;
    visible.set(ev.action.id, { action: ev.action, profileId });
    streamDeck.logger.info(
      `[profileKey] didReceiveSettings key=${ev.action.id} profileId=${JSON.stringify(profileId)}`,
    );
    await repaintAll(await streamDeck.settings.getGlobalSettings());
  }

  /**
   * Property inspector requests: live hardware options, saves, avatars.
   *
   * Replies go through streamDeck.ui, NOT ev.action — the action object has no
   * sendToPropertyInspector. Calling it there threw after the work had already
   * been done, so saves landed but the inspector never heard back and sat
   * waiting forever on a reply that could not arrive.
   */
  async onSendToPlugin(ev) {
    const request = ev.payload?.request;
    // Logged before any await: a later log line cannot distinguish "never
    // arrived" from "arrived and hung part-way through".
    streamDeck.logger.info(
      `[pi] <- ${request} (${JSON.stringify(ev.payload ?? {}).length} bytes)`,
    );
    try {
      const reply = await handlePiRequest(ev.payload, {
        settings: streamDeck.settings,
        logger: streamDeck.logger,
        // The browser editor saves without the inspector in the loop, so it
        // needs its own way to say "the keys are stale now".
        onChanged: refreshKeys,
      });
      await streamDeck.ui.sendToPropertyInspector(reply);
      streamDeck.logger.info(`[pi] ${request} -> ${JSON.stringify(reply).slice(0, 200)}`);

      // A save or avatar change alters what the keys should look like.
      if (['saveProfiles', 'uploadAvatar', 'deleteAvatar'].includes(request)) {
        await refreshKeys();
      }
    } catch (err) {
      // Never leave the inspector hanging: it awaits a reply per request.
      streamDeck.logger.error(`[pi] ${request} failed: ${err.stack ?? err.message}`);
      await streamDeck.ui
        .sendToPropertyInspector({ request, ok: false, error: err.message })
        .catch(() => {});
    }
  }

  /**
   * Note the ordering here: the hold clock starts SYNCHRONOUSLY, before any
   * await. Fetching global settings is a websocket round-trip, and starting
   * the timer after it meant a genuine one-second hold released before the
   * timer had run its course — the key looked dead.
   */
  onKeyDown(ev) {
    const held = { cancelled: false };
    this.#timers.set(ev.action.id, held);

    // The key event carries live settings; trust them over anything cached.
    visible.set(ev.action.id, { action: ev.action, profileId: ev.payload.settings?.profileId });

    const startedAt = Date.now();
    const settingsPromise = streamDeck.settings.getGlobalSettings();

    // Paint the hold filling up so the gate reads as deliberate, not broken.
    held.tick = setInterval(async () => {
      if (held.cancelled) return;
      const profile = findProfile(await settingsPromise, ev.payload.settings?.profileId);
      if (!profile) return;
      const progress = Math.min(1, (Date.now() - startedAt) / HOLD_MS);
      await ev.action.setImage(renderProfileKey({ profile, active: false, holdProgress: progress }));
    }, 100);

    (async () => {
      const settings = await settingsPromise;
      const wanted = ev.payload.settings?.profileId;
      const profile = findProfile(settings, wanted);

      streamDeck.logger.info(
        `[profileKey] keyDown key=${ev.action.id} profileId=${JSON.stringify(wanted)} ` +
          `resolved=${profile ? profile.name : 'NONE'} restricted=${profile?.restricted ?? '-'}`,
      );

      if (!profile) {
        this.#clear(ev.action.id);
        streamDeck.logger.warn(
          `[profileKey] this key has no profile assigned — pick one in the property inspector`,
        );
        return ev.action.showAlert();
      }

      if (!profile.restricted) {
        this.#clear(ev.action.id);
        return this.#switch(ev, profile, settings);
      }

      const remaining = Math.max(0, HOLD_MS - (Date.now() - startedAt));
      held.timer = setTimeout(() => {
        if (held.cancelled) return;
        this.#clear(ev.action.id);
        this.#switch(ev, profile, settings);
      }, remaining);
    })();
  }

  async onKeyUp(ev) {
    const held = this.#timers.get(ev.action.id);
    streamDeck.logger.info(
      `[profileKey] keyUp key=${ev.action.id} pending=${Boolean(held)}`,
    );
    if (!held) return; // already fired
    // Released before the hold completed — nothing was applied.
    this.#clear(ev.action.id);
    await ev.action.showAlert();

    const settings = await streamDeck.settings.getGlobalSettings();
    await repaintAll(settings);
  }

  #clear(id) {
    const held = this.#timers.get(id);
    if (!held) return;
    held.cancelled = true;
    clearInterval(held.tick);
    clearTimeout(held.timer);
    this.#timers.delete(id);
  }

  async #switch(ev, profile, settings) {
    activeProfileId = profile.id;
    activeStatus = STATUS.APPLIED_UNVERIFIED;
    switchingProfileId = profile.id;
    // Repaint everything now rather than only the key that was pressed. The
    // profile being left has to stop looking active immediately; waiting for
    // applyProfile means it stays lit for as long as the hardware takes.
    await repaintAll(settings);

    // Dots that do not move mean nothing. Keys are static images, so animating
    // is a matter of pushing a new one a few times a second — cheap, since each
    // frame is a few hundred bytes of SVG over a websocket that is already open.
    //
    // The interval is cleared in a `finally`. A timer that outlives a failed
    // switch would sit there animating a key that is no longer doing anything,
    // which is worse than no animation at all.
    const painted = findProfile(settings, profile.id) ?? profile;
    let frame = 0;
    const dots = setInterval(() => {
      frame += 1;
      ev.action
        .setImage(
          renderProfileKey({ profile: painted, active: false, switching: true, dotFrame: frame }),
        )
        .catch(() => {});
    }, 220);

    let outcome;
    try {
      outcome = await applyProfile(profile, {
        // Global settings hold credentials (the Govee key) and device
        // allowlists; providers need them alongside their own config slice.
        settings: settings?.settings ?? {},
        log: (m) => streamDeck.logger.info(m),
        // Log every provider as it lands, not just the aggregate. The button
        // shows the worst status, so a failing wheelbase was hiding whether
        // the lights or the pedal did anything at all.
        onResult: (r) =>
          streamDeck.logger.info(
            `[profileKey] ${profile.name} · ${r.label}: ${r.status} — ${r.detail}`,
          ),
      });
    } finally {
      clearInterval(dots);
    }

    activeStatus = outcome.status;
    switchingProfileId = null;
    writeState(profile.id);

    // Every switch is announced, not just the broken ones. From the seat the
    // deck is often out of eyeline, and "did that work?" is the question worth
    // answering every time — a toast that only ever appears on failure teaches
    // you to ignore the absence of one.
    const why = summarise(outcome);
    if (isProblem(outcome.status)) {
      await ev.action.showAlert();
      streamDeck.logger.warn(`[profileKey] ${profile.name}: ${why}`);
      notify(`${profile.name} — profile not fully applied`, why);
    } else {
      await ev.action.showOk();
      streamDeck.logger.info(`[profileKey] ${profile.name}: ${why}`);
      notify(`${profile.name} active`, describeOutcome(outcome));
    }
    await repaintAll(settings);
  }
}

export function _resetForTesting() {
  visible.clear();
  activeProfileId = null;
  activeStatus = STATUS.SKIPPED;
  hydrated = false;
}

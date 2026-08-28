// actions/sceneKey.js — "Rig Scene" action.
//
// A scene is the momentary half of this plugin. It fires whatever providers it
// is configured with and is over: ambient lighting, a script, a playlist. It
// is not a claim about anything.
//
// The distinction from a profile is not cosmetic, and it is the reason this is
// a separate action rather than a flag on the existing one:
//
//   * A profile says WHO IS AT THE RIG. It is exclusive, it persists to
//     state.json, and it mirrors to a shared file a companion plugin reads to
//     decide what a child is allowed to launch. A scene writes none of that —
//     turning the lights blue must never change who the rig thinks is driving.
//   * A profile can be restricted, gated behind a deliberate hold so a stray
//     press cannot reach full force feedback. A scene has nothing to gate.
//   * A profile owns its key's appearance: lit when active, dark when not.
//     A scene has no on state, so its key never claims one.
//
// That last difference is what makes this one safe inside a Multi Action while
// the profile action is not. An action in a Multi Action has no coordinates,
// so setImage has nothing to target and keyDown/keyUp arrive back to back —
// which silently disables the hold gate. A scene needs neither, so it composes
// with the deck's native actions exactly as the user would expect.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { applyProfile, summarise } from '../profileSwitch.js';
import { renderSceneKey } from '../buttonRenderer.js';
import { notify } from '../notify.js';
import { isProblem } from '../providers/index.js';
import { loadAvatarDataUri } from '../avatars.js';

export const MANIFEST_ID = 'com.rig.profiles.scene';

/** Frame interval while a scene runs, matching the profile key's dots. */
const DOT_MS = 220;

function findScene(settings, id) {
  const scene = (settings?.scenes ?? []).find((s) => s.id === id) ?? null;
  if (!scene?.avatar) return scene;
  return { ...scene, avatarDataUri: loadAvatarDataUri(scene.avatar) ?? undefined };
}

export class SceneKey extends SingletonAction {
  manifestId = MANIFEST_ID;

  async onWillAppear(ev) {
    await this.#paint(ev);
  }

  async onDidReceiveSettings(ev) {
    await this.#paint(ev);
  }

  async #paint(ev, { running = false, dotFrame = null } = {}) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const scene = findScene(settings, ev.payload?.settings?.sceneId);
    await ev.action.setImage(renderSceneKey({ scene, running, dotFrame }));
  }

  /**
   * Scenes fire on press, not release.
   *
   * There is no hold to wait for and nothing to confirm, and in a Multi Action
   * keyUp arrives immediately anyway — so deferring to release would buy
   * nothing and behave differently depending on where the action sits.
   */
  async onKeyDown(ev) {
    const settings = await streamDeck.settings.getGlobalSettings();
    const sceneId = ev.payload?.settings?.sceneId;
    const scene = findScene(settings, sceneId);

    streamDeck.logger.info(
      `[sceneKey] keyDown key=${ev.action.id} sceneId=${JSON.stringify(sceneId)} ` +
        `resolved=${scene ? scene.name : 'NONE'}`,
    );

    if (!scene) {
      // An unassigned key that silently does nothing is how a dropdown left on
      // its placeholder went unnoticed until someone pressed it.
      await ev.action.showAlert();
      return;
    }

    let frame = 0;
    const dots = setInterval(() => {
      frame += 1;
      ev.action
        .setImage(renderSceneKey({ scene, running: true, dotFrame: frame }))
        .catch(() => {});
    }, DOT_MS);
    await ev.action.setImage(renderSceneKey({ scene, running: true, dotFrame: 0 }));

    let outcome;
    try {
      outcome = await applyProfile(scene, {
        settings: settings?.settings ?? {},
        // Declares which half of the plugin this is, so a provider that only
        // offers itself to profiles cannot be reached through a scene even if
        // a hand-edited config names it.
        context: 'scene',
        log: (m) => streamDeck.logger.info(m),
        onResult: (r) =>
          streamDeck.logger.info(`[sceneKey] ${scene.name} · ${r.label}: ${r.status} — ${r.detail}`),
      });
    } catch (err) {
      // applyProfile does not normally throw, but a scene must never take the
      // plugin down or leave its key spinning.
      streamDeck.logger.error(`[sceneKey] ${scene.name} failed: ${err.stack ?? err.message}`);
      outcome = { status: 'failed', results: [], error: err.message };
    } finally {
      clearInterval(dots);
    }

    const why = outcome.error ?? summarise(outcome);
    if (isProblem(outcome.status)) {
      await ev.action.showAlert();
      streamDeck.logger.warn(`[sceneKey] ${scene.name}: ${why}`);
      notify(`${scene.name} — scene failed`, why, { logger: streamDeck.logger });
    } else {
      await ev.action.showOk();
      streamDeck.logger.info(`[sceneKey] ${scene.name}: ${why}`);
    }

    // Deliberately no state written and no other key repainted: a scene has no
    // bearing on which profile is active, and saying otherwise would corrupt
    // the one thing the shared state file means.
    await this.#paint(ev);
  }
}

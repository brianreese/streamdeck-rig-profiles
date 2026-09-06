// actions/editorKey.js — "Open Editor" action.
//
// A key that opens the settings editor in a browser. Brian's reason, from the
// sibling plugin where this landed first: "Going through the stream deck UI just
// finding a preset just to launch the editor is a bit painful." It was — the
// only way in was a profile key's property inspector, so reaching a browser page
// meant opening the Stream Deck app and selecting a key first.
//
// HOW IT DIFFERS FROM EVERY OTHER KEY HERE
//
// It touches no hardware and no rig state. It does not switch a profile, write a
// flag, talk to MQTT or change any light. It starts a local HTTP server if one
// is not already running and opens a browser at it, which makes it the one key
// in this plugin that is safe to press at any moment, including mid-session.
//
// It has no property inspector, because it has nothing to configure. A panel
// holding one sentence is worse than no panel: it implies a setting exists.
//
// Pressing it twice is harmless — `startEditor` returns the running server's URL
// rather than binding a second port.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { renderModeKey } from '../buttonRenderer.js';
import { openEditor } from '../openEditor.js';

const MANIFEST_ID = 'com.rig.profiles.editor';

/**
 * The key's face.
 *
 * Drawn through `renderModeKey` rather than a bespoke renderer so it sits on a
 * deck beside the others without looking like it came from somewhere else. A
 * grey that is deliberately not any provider's colour: this key does not
 * represent a thing that can be on or off.
 */
const FACE = { name: 'Editor', color: '#3B4252' };

export class EditorKey extends SingletonAction {
  manifestId = MANIFEST_ID;

  /**
   * @param {object} [deps]
   * @param {Function} [deps.open]  injected so a test opens no browser and binds
   *   no port. The default is the real thing.
   */
  constructor({ open = openEditor } = {}) {
    super();
    this.open = open;
  }

  async onWillAppear(ev) {
    await ev.action.setImage(renderModeKey({ mode: FACE, active: null })).catch(() => {});
  }

  async onKeyUp(ev) {
    const logger = streamDeck.logger;
    try {
      const { url, alreadyRunning } = await this.open({
        settings: streamDeck.settings,
        logger,
        onChanged: () => {},
      });
      logger.info?.(`[editor] ${alreadyRunning ? 'already at' : 'started at'} ${url}`);
      await ev.action.showOk();
    } catch (err) {
      // The key cannot hold a reason, and the log can. Failing loudly here beats
      // a key that flashes OK while nothing opens.
      logger.error?.(`[editor] could not open: ${err.stack ?? err.message}`);
      await ev.action.showAlert();
    }
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as rawRequest } from 'http';
import { startEditor, stopEditor, openInBrowser } from './editorServer.js';
import { _resetForTesting } from './providers/index.js';

const silent = { warn: () => {}, info: () => {}, error: () => {} };

function fakeSettings(initial = {}) {
  let store = initial;
  return {
    written: () => store,
    async getGlobalSettings() { return store; },
    async setGlobalSettings(next) { store = next; },
  };
}

const profile = (over = {}) => ({
  id: 'kai', name: 'Kai', color: '#22AA44',
  providers: { 'fanatec-base': { setup: 2 } }, ...over,
});

let server;

/** POST one request the way the page does, token header included. */
function api(request, extra = {}, { token = server.token } = {}) {
  return fetch(`http://127.0.0.1:${server.port}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rig-editor': token },
    body: JSON.stringify({ request, ...extra }),
  });
}

async function start(settings, deps = {}) {
  const { url, port } = await startEditor({ settings, logger: silent, ...deps });
  server = { url, port, token: new URL(url).searchParams.get('t') };
  return server;
}

beforeEach(() => _resetForTesting());
afterEach(() => stopEditor());

describe('startEditor', () => {
  it('binds loopback only, on a port the OS picked', async () => {
    await start(fakeSettings({ profiles: [] }));
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
  });

  it('returns the running server rather than binding a second one', async () => {
    await start(fakeSettings({ profiles: [] }));
    const again = await startEditor({ settings: fakeSettings(), logger: silent });
    expect(again.alreadyRunning).toBe(true);
    expect(again.port).toBe(server.port);
  });

  it('serves the page to a request carrying the token', async () => {
    await start(fakeSettings({ profiles: [] }));
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Rig Profiles</title>');
  });

  it('serves the page its state module, under the same token', async () => {
    await start(fakeSettings({ profiles: [] }));
    const url = `http://127.0.0.1:${server.port}/editorState.js`;
    const res = await fetch(`${url}?t=${server.token}`);
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(await res.text()).toContain('export function addProfile');
    expect((await fetch(url)).status).toBe(403);
  });

  it('serves the contrast module the key renderer shares, from src/', async () => {
    // Not a copy in ui/: the editor and the deck must agree on what is
    // readable, and two files would eventually disagree.
    await start(fakeSettings({ profiles: [] }));
    const url = `http://127.0.0.1:${server.port}/contrast.js`;
    const res = await fetch(`${url}?t=${server.token}`);
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(await res.text()).toContain('export function readableTextColor');
    expect((await fetch(url)).status).toBe(403);
  });

  it('hands out nothing but the three files on the allowlist', async () => {
    await start(fakeSettings({ profiles: [] }));
    for (const path of ['/piBridge.js', '/../package.json', '/editor.html', '/moza/frame.js']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}?t=${server.token}`);
      expect(res.status).toBe(404);
    }
  });

  it('refuses the page without the token', async () => {
    await start(fakeSettings({ profiles: [] }));
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
  });

  it('refuses an API call without the token — any page in the browser can POST here', async () => {
    await start(fakeSettings({ profiles: [] }));
    expect((await api('getProfiles', {}, { token: 'wrong' })).status).toBe(403);
  });

  it('refuses a request that arrived under another hostname (DNS rebinding)', async () => {
    await start(fakeSettings({ profiles: [] }));
    // fetch() will not let a caller forge Host — it is a forbidden header — so
    // this goes out over the raw client, which is what a rebinding attack has
    // the browser do for it anyway.
    const status = await new Promise((ok, fail) => {
      const req = rawRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/?t=${server.token}`,
          headers: { host: 'evil.example.com' },
        },
        (res) => { res.resume(); ok(res.statusCode); },
      );
      req.on('error', fail);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('the API', () => {
  it('lists profiles but never the Govee key', async () => {
    await start(fakeSettings({ profiles: [profile()], settings: { goveeApiKey: 'secret' } }));
    const body = await (await api('getProfiles')).json();
    expect(body.profiles).toHaveLength(1);
    expect(body.settings.goveeApiKeySet).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('saves through the same path the inspector uses', async () => {
    const settings = fakeSettings({ profiles: [], settings: { goveeApiKey: 'secret' } });
    await start(settings);
    const body = await (await api('saveProfiles', { profiles: [profile()] })).json();
    expect(body.ok).toBe(true);
    expect(settings.written().profiles[0].id).toBe('kai');
    // The page is never told the key, so a save from it must not clear one.
    expect(settings.written().settings.goveeApiKey).toBe('secret');
  });

  it('rejects an invalid profile server-side, whatever the page believes', async () => {
    const settings = fakeSettings({ profiles: [] });
    await start(settings);
    const body = await (await api('saveProfiles', {
      profiles: [profile({ color: 'green' })],
    })).json();
    expect(body.ok).toBe(false);
    expect(body.errors.join()).toMatch(/colour/);
    expect(settings.written().profiles).toHaveLength(0);
  });

  it('tells the plugin to repaint after a save', async () => {
    const changed = [];
    await start(fakeSettings({ profiles: [] }), { onChanged: (r) => changed.push(r) });
    await api('saveProfiles', { profiles: [profile()] });
    await api('getProfiles');
    expect(changed).toEqual(['saveProfiles']);
  });

  it('renders a key preview from the draft, not from what is saved', async () => {
    await start(fakeSettings({ profiles: [] }));
    const body = await (await api('previewKey', {
      profile: { name: 'Kai', color: '#22AA44' },
    })).json();
    expect(body.off).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(body.on).not.toBe(body.off);
  });

  it('answers an unknown request rather than hanging', async () => {
    await start(fakeSettings({ profiles: [] }));
    const body = await (await api('nonsense')).json();
    expect(body.error).toMatch(/unknown request/);
  });
});

describe('stopEditor', () => {
  it('closes the port', async () => {
    await start(fakeSettings({ profiles: [] }));
    const { port } = server;
    expect(await stopEditor()).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('is safe to call when nothing is running', async () => {
    expect(await stopEditor()).toBe(false);
  });
});

describe('openInBrowser', () => {
  it('hands the URL to the platform opener', () => {
    const calls = [];
    openInBrowser('http://127.0.0.1:1234/?t=abc', {
      logger: silent,
      spawnFn: (cmd, args) => { calls.push([cmd, args]); return { on() {}, unref() {} }; },
    });
    expect(calls[0][1]).toContain('http://127.0.0.1:1234/?t=abc');
  });

  it('survives an opener that will not launch', () => {
    const ok = openInBrowser('http://127.0.0.1:1234/', {
      logger: silent,
      spawnFn: () => { throw new Error('ENOENT'); },
    });
    expect(ok).toBe(false);
  });
});

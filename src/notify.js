// notify.js — put a failure somewhere the user can actually read it.
//
// A key that goes amber says something went wrong and nothing about what. The
// detail exists — every provider reports why — but it only reached the log, and
// nobody reads a log from the driver's seat. Windows toasts auto-dismiss, sit
// above a fullscreen game, and cost nothing when ignored.
//
// The Stream Deck SDK has no notification API, so this goes through Windows'
// own. Two details make it reliable without installing anything:
//
//   * The script is passed as -EncodedCommand (base64 UTF-16LE), so a profile
//     called O'Brien or an error containing quotes cannot break the command
//     line or inject PowerShell.
//   * The toast is shown under PowerShell's registered AppUserModelID. Windows
//     silently drops toasts from an unregistered id, and registering one means
//     writing a Start Menu shortcut — too much for an error message.
//
// Failure here is never worth surfacing: the notification is the fallback, so
// if it does not work the log entry the caller already wrote still stands.

import { spawn } from 'child_process';

const POWERSHELL_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Toast bodies are XML; a stray & or < would make the document unparseable. */
function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Long provider details wrap into an unreadable wall; a toast is a headline. */
function trim(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function buildScript(title, body) {
  const xml =
    '<toast duration="short"><visual><binding template="ToastGeneric">' +
    `<text>${escapeXml(trim(title, 64))}</text>` +
    `<text>${escapeXml(trim(body, 180))}</text>` +
    '</binding></visual></toast>';

  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(@'\n${xml}\n'@)`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join('\n');
}

/**
 * Show a toast. Fire and forget — never throws, never blocks a profile switch.
 */
export function notify(title, body, { spawnFn = spawn, logger = null, platform = process.platform } = {}) {
  if (platform !== 'win32') return false;

  try {
    const encoded = Buffer.from(buildScript(title, body), 'utf16le').toString('base64');
    const child = spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    // Without this the plugin holds the process open and Windows shows a
    // console window flicker on some machines.
    child.unref?.();
    child.on?.('error', (err) => logger?.warn?.(`[notify] ${err.message}`));
    return true;
  } catch (err) {
    logger?.warn?.(`[notify] ${err.message}`);
    return false;
  }
}

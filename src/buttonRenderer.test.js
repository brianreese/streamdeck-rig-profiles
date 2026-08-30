import { describe, it, expect } from 'vitest';
import { renderProfileKey, renderModeKey } from './buttonRenderer.js';
import { STATUS } from './providers/status.js';
import { relativeLuminance } from './contrast.js';

const profile = { name: 'Kai', color: '#22AA44' };

/** Decode a data URI back to SVG source so we can assert on what was drawn. */
function svgOf(dataUri) {
  expect(dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  return Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
}

describe('renderProfileKey', () => {
  it('paints the profile colour when active and verified', () => {
    const svg = svgOf(renderProfileKey({ profile, active: true, status: STATUS.VERIFIED }));
    expect(svg).toContain('#22AA44');
    expect(svg).toContain('Kai');
  });

  it('marks a verified key with a confirmation dot', () => {
    const ok = svgOf(renderProfileKey({ profile, active: true, status: STATUS.VERIFIED }));
    const notOk = svgOf(renderProfileKey({ profile, active: true, status: STATUS.MISMATCH }));
    expect(ok).toContain('<circle');
    expect(notOk).not.toContain('<circle');
  });

  it('goes genuinely dark when inactive, not merely outlined', () => {
    // Asserts the property rather than a literal hex: what matters is that the
    // tile is actually dark, so the one lit key is the only lit thing on the
    // deck. The exact shade is a design choice and may move again.
    const svg = svgOf(renderProfileKey({ profile, active: false }));
    const bg = /<rect width="144" height="144" fill="(#[0-9a-f]{6})"/i.exec(svg)[1];
    expect(relativeLuminance(bg)).toBeLessThan(0.02);
  });

  it('carries the profile colour in the monogram when inactive', () => {
    // A grey box with a "C" on it does not say Carter. The colour has to be
    // somewhere, and the letter is where it costs nothing.
    const svg = svgOf(renderProfileKey({ profile, active: false }));
    expect(svg).toContain('#22AA44');
    expect(svg).toContain('>K<');
  });

  it('replaces the name with dots while switching, keeping the monogram', () => {
    const svg = svgOf(renderProfileKey({ profile, active: false, switching: true, dotFrame: 1 }));
    expect(svg).not.toContain('>Kai<');
    expect(svg).toContain('>K<');
    expect((svg.match(/<circle/g) ?? []).length).toBe(3);
  });

  it('moves the lit dot from frame to frame, or the animation says nothing', () => {
    const at = (f) =>
      svgOf(renderProfileKey({ profile, active: false, switching: true, dotFrame: f }));
    expect(at(0)).not.toBe(at(1));
    // Three dots, so the cycle closes.
    expect(at(0)).toBe(at(3));
  });

  it('inks a pale profile colour dark rather than white-on-white', () => {
    const pale = { name: 'Carter', color: '#F2C230' };
    const svg = svgOf(renderProfileKey({ profile: pale, active: true, status: STATUS.VERIFIED }));
    expect(svg).toContain('#141414');
    expect(svg).not.toContain('#FFFFFF');
  });

  it('shows an amber stripe when applied but unverified', () => {
    const svg = svgOf(renderProfileKey({ profile, active: true, status: STATUS.APPLIED_UNVERIFIED }));
    expect(svg).toContain('#E8A317');
  });

  it('shows a red stripe when the hardware is unreachable', () => {
    const svg = svgOf(renderProfileKey({ profile, active: true, status: STATUS.UNREACHABLE }));
    expect(svg).toContain('#D64545');
  });

  it('renders the unknown state without claiming a profile is active', () => {
    const svg = svgOf(renderProfileKey({ profile, active: true, unknown: true }));
    expect(svg).toContain('?');
    expect(svg).not.toContain('#22AA44');
  });

  it('escapes names so a stray character cannot break the SVG', () => {
    const svg = svgOf(renderProfileKey({ profile: { name: 'A & B <x>', color: '#111111' }, active: false }));
    expect(svg).toContain('A &amp; B &lt;x&gt;');
    expect(svg).not.toContain('<x>');
  });

  it('falls back to an initial when no avatar is set', () => {
    const svg = svgOf(renderProfileKey({ profile, active: true, status: STATUS.VERIFIED }));
    expect(svg).toContain('>K<');
  });

  it('embeds the avatar when one is provided', () => {
    const withAvatar = { ...profile, avatarDataUri: 'data:image/png;base64,AAAA' };
    const svg = svgOf(renderProfileKey({ profile: withAvatar, active: true, status: STATUS.VERIFIED }));
    expect(svg).toContain('<image');
    expect(svg).toContain('data:image/png;base64,AAAA');
  });

  it('survives a malformed colour rather than emitting broken markup', () => {
    const svg = svgOf(renderProfileKey({ profile: { name: 'X', color: 'not-a-colour' }, active: false }));
    expect(svg).toContain('<svg');
  });
});

describe('renderModeKey', () => {
  const mode = { name: 'Ambient', color: '#22AA44' };

  it('claims neither profile state', () => {
    // A scene has no on state. Borrowing the lit look would claim to be
    // active; borrowing the dark one would read as switched off.
    const idle = svgOf(renderModeKey({ mode }));
    const bg = /<rect width="144" height="144" fill="(#[0-9a-f]{6})"/i.exec(idle)[1];
    const lum = relativeLuminance(bg);
    expect(lum).toBeGreaterThan(relativeLuminance('#131519')); // brighter than off
    expect(lum).toBeLessThan(relativeLuminance(mode.color)); // dimmer than active
  });

  it('shows dots while running, in place of the name', () => {
    const running = svgOf(renderModeKey({ mode, running: true, dotFrame: 1 }));
    expect(running).not.toContain('>Ambient<');
    expect((running.match(/<circle/g) ?? []).length).toBe(3);
  });

  it('is visibly busy rather than merely re-rendered', () => {
    const idle = svgOf(renderModeKey({ mode }));
    const running = svgOf(renderModeKey({ mode, running: true, dotFrame: 0 }));
    expect(running).not.toBe(idle);
  });

  it('falls back to the unconfigured key when no scene is bound', () => {
    expect(svgOf(renderModeKey({ mode: null }))).toContain('Pick a');
  });
});

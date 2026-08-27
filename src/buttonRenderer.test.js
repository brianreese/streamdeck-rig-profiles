import { describe, it, expect } from 'vitest';
import { renderProfileKey } from './buttonRenderer.js';
import { STATUS } from './providers/status.js';

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
    const svg = svgOf(renderProfileKey({ profile, active: false }));
    expect(svg).toContain('#141414');
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

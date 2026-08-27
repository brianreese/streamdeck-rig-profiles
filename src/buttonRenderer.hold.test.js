import { describe, it, expect } from 'vitest';
import { renderProfileKey } from './buttonRenderer.js';

const profile = { name: 'Brian', color: '#2255CC' };
const svgOf = (uri) => Buffer.from(uri.split(',')[1], 'base64').toString('utf8');

describe('hold feedback', () => {
  it('draws a progress bar while a restricted key is held', () => {
    const svg = svgOf(renderProfileKey({ profile, active: false, holdProgress: 0.5 }));
    expect(svg).toContain('#FFFFFF');
    expect(svg).toContain('width="72"'); // half of 144
  });

  it('grows the bar as the hold advances', () => {
    const at = (p) => svgOf(renderProfileKey({ profile, active: false, holdProgress: p }));
    expect(at(0.25)).toContain('width="36"');
    expect(at(1)).toContain('width="144"');
  });

  it('clamps out-of-range progress instead of drawing past the key', () => {
    expect(svgOf(renderProfileKey({ profile, active: false, holdProgress: 5 }))).toContain('width="144"');
    expect(svgOf(renderProfileKey({ profile, active: false, holdProgress: -1 }))).toContain('width="0"');
  });

  it('does not draw a progress bar when not holding', () => {
    // y=138 is the bottom strip the progress bar occupies; the colour swatch
    // is also 6px tall, so match on position rather than height alone.
    const svg = svgOf(renderProfileKey({ profile, active: false }));
    expect(svg).not.toContain('y="138"');
  });
});

describe('unconfigured key', () => {
  it('renders a distinct "pick a profile" key when none is assigned', () => {
    const svg = svgOf(renderProfileKey({ profile: null, active: false }));
    expect(svg).toContain('Pick a');
    expect(svg).toContain('profile');
    expect(svg).toContain('#E8A317');
  });

  it('does not look like a working profile key', () => {
    const unset = svgOf(renderProfileKey({ profile: null, active: false }));
    const set = svgOf(renderProfileKey({ profile, active: false }));
    expect(unset).not.toBe(set);
    expect(unset).not.toContain('#2255CC');
  });
});

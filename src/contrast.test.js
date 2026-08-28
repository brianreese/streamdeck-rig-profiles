import { describe, it, expect } from 'vitest';
import {
  parseHex, relativeLuminance, contrastRatio, readableTextColor, isLight, INK,
} from './contrast.js';

describe('parseHex', () => {
  it('reads both shorthand and full hex, with or without the hash', () => {
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(parseHex('2255CC')).toEqual([34, 85, 204]);
  });

  it('refuses anything that is not a hex colour', () => {
    for (const bad of ['green', '#12345', '', null, undefined, '#gggggg']) {
      expect(parseHex(bad)).toBeNull();
    }
  });
});

describe('relativeLuminance', () => {
  it('anchors at black and white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
  });

  it('weights the channels by how bright the eye finds them', () => {
    // Pure green is over ten times brighter than pure blue. This is the whole
    // reason the naive (r+g+b)/3 approach gets tiles wrong.
    expect(relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 4);
  });

  it('treats an unparseable colour as darkest rather than throwing', () => {
    expect(relativeLuminance('rebeccapurple')).toBe(0);
  });
});

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#2255cc', '#2255cc')).toBeCloseTo(1, 6);
  });

  it('does not care which way round the colours are given', () => {
    expect(contrastRatio('#ffe066', '#141414')).toBeCloseTo(contrastRatio('#141414', '#ffe066'), 9);
  });
});

describe('readableTextColor', () => {
  it('puts dark ink on a light tile and light ink on a dark one', () => {
    expect(readableTextColor('#ffffff')).toBe(INK.dark);
    expect(readableTextColor('#000000')).toBe(INK.light);
  });

  it('separates two colours a naive average cannot tell apart', () => {
    // Both average to 85 across r/g/b, and they need opposite foregrounds.
    expect(readableTextColor('#00ff00')).toBe(INK.dark);
    expect(readableTextColor('#0000ff')).toBe(INK.light);
  });

  it('keeps white on the default profile blue', () => {
    expect(readableTextColor('#2255cc')).toBe(INK.light);
  });

  it('flips to dark on the pale colours that used to be unreadable', () => {
    for (const pale of ['#ffe066', '#f7c8d8', '#c9f0a0', '#e8e8e8']) {
      expect(readableTextColor(pale)).toBe(INK.dark);
    }
  });

  it('always chooses the higher-contrast of the two inks it is given', () => {
    for (const bg of ['#2255cc', '#22aa44', '#ffe066', '#404040', '#8a8a8a']) {
      const chosen = readableTextColor(bg);
      const other = chosen === INK.dark ? INK.light : INK.dark;
      expect(contrastRatio(bg, chosen)).toBeGreaterThanOrEqual(contrastRatio(bg, other));
    }
  });

  it('honours custom inks', () => {
    expect(readableTextColor('#ffffff', { dark: '#333333', light: '#eeeeee' })).toBe('#333333');
  });

  it('falls back to light ink for a colour it cannot read', () => {
    expect(readableTextColor(undefined)).toBe(INK.light);
  });
});

describe('isLight', () => {
  it('agrees with the ink that was chosen', () => {
    expect(isLight('#ffe066')).toBe(true);
    expect(isLight('#2255cc')).toBe(false);
  });
});

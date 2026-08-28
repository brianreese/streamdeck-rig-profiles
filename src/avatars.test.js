import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveAvatar, loadAvatarDataUri, deleteAvatar } from './avatars.js';

describe('one avatar directory, two id spaces', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const tmp = () => mkdtempSync(join(tmpdir(), 'avatars-'));

  it('does not delete an unrelated id that starts with the same letters', () => {
    // The cleanup matched on startsWith, so saving for "brian" removed the
    // avatars of "brian2" and "brianx" — replacing one picture quietly took
    // every id beginning with the same characters.
    const dir = tmp();
    saveAvatar('brian2', png, 'a.png', { dir });
    saveAvatar('brianx', png, 'a.png', { dir });
    saveAvatar('brian', png, 'a.png', { dir });
    expect(readdirSync(dir).sort()).toEqual([
      'profile-brian.png',
      'profile-brian2.png',
      'profile-brianx.png',
    ]);
  });

  it('keeps a profile and a scene of the same name apart', () => {
    // Profiles and scenes have separate id spaces, so "brian" can be both.
    const dir = tmp();
    saveAvatar('brian', png, 'a.png', { dir, kind: 'profile' });
    saveAvatar('brian', png, 'b.png', { dir, kind: 'scene' });
    expect(readdirSync(dir).sort()).toEqual(['profile-brian.png', 'scene-brian.png']);
  });

  it('still replaces an owner\'s own avatar across extensions', () => {
    const dir = tmp();
    saveAvatar('kai', png, 'a.png', { dir });
    const { filename } = saveAvatar('kai', png, 'b.jpg', { dir });
    expect(readdirSync(dir)).toEqual([filename]);
    expect(filename).toBe('profile-kai.jpg');
  });

  it('lets a profile replace an avatar saved before names were namespaced', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'kai.png'), Buffer.from(png, 'base64'));
    saveAvatar('kai', png, 'a.png', { dir });
    expect(readdirSync(dir)).toEqual(['profile-kai.png']);
  });

  it('never lets a scene claim a legacy file, which can only be a profile\'s', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'brian.png'), Buffer.from(png, 'base64'));
    saveAvatar('brian', png, 'a.png', { dir, kind: 'scene' });
    expect(readdirSync(dir).sort()).toEqual(['brian.png', 'scene-brian.png']);
  });
});

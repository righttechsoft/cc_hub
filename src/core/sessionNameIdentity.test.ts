import { describe, expect, it } from 'vitest';
import { slugifySessionName } from './sessionNameIdentity.js';

describe('slugifySessionName', () => {
  it('adopts a bare short label unchanged', () => {
    expect(slugifySessionName('wb-sync')).toBe('wb-sync');
  });

  it('adopts a two-word label, lowercased with a hyphen', () => {
    expect(slugifySessionName('CSV Export')).toBe('csv-export');
  });

  it('adopts a three-word label (the boundary)', () => {
    expect(slugifySessionName('fix login bug')).toBe('fix-login-bug');
  });

  it('rejects a sentence-like auto-generated title (more than 3 words)', () => {
    expect(slugifySessionName('Display agent info on console top line')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(slugifySessionName('')).toBeNull();
    expect(slugifySessionName('   ')).toBeNull();
  });

  it('rejects a name whose slug exceeds 40 characters', () => {
    expect(slugifySessionName('a'.repeat(45))).toBeNull();
  });

  it('accepts a slug at exactly the 40-char boundary', () => {
    const name = 'a'.repeat(40);
    expect(slugifySessionName(name)).toBe(name);
  });

  it('rejects a name that slugifies to empty (all punctuation)', () => {
    expect(slugifySessionName('!!!')).toBeNull();
  });

  it('accepts a single alphanumeric character (the regex minimum)', () => {
    expect(slugifySessionName('a')).toBe('a');
    expect(slugifySessionName('9')).toBe('9');
  });

  it('collapses internal whitespace and underscores into single hyphens', () => {
    expect(slugifySessionName('wb   sync')).toBe('wb-sync');
    expect(slugifySessionName('wb_sync')).toBe('wb-sync');
  });

  it('strips characters outside [a-z0-9_-]', () => {
    expect(slugifySessionName('wb/sync!')).toBe('wbsync');
  });

  it('trims leading/trailing hyphens produced by stripped punctuation', () => {
    expect(slugifySessionName('-wb-sync-')).toBe('wb-sync');
  });
});

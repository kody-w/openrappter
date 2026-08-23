import { describe, expect, it } from 'vitest';
import { compareSemVer } from '../services/release-rings.js';

describe('release-ring SemVer ordering', () => {
  it.each([
    ['1.9.8-beta.1', '1.9.8', -1],
    ['1.9.8-beta.2', '1.9.8-beta.10', -1],
    ['1.9.8-2', '1.9.8-beta', -1],
    ['1.9.8-beta.10', '1.9.8-beta.2', 1],
  ])('compares %s to %s', (left, right, expected) => {
    expect(compareSemVer(left, right)).toBe(expected);
  });
});

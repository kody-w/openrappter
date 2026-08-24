import { describe, expect, it } from 'vitest';
import { compareSemVer, parseCandidateBundleUrl } from '../services/release-rings.js';

describe('release-ring SemVer ordering', () => {
  it.each([
    ['1.9.8-beta.1', '1.9.8', -1],
    ['1.9.8-beta.2', '1.9.8-beta.10', -1],
    ['1.9.8-2', '1.9.8-beta', -1],
    ['1.9.8-beta.10', '1.9.8-beta.2', 1],
  ])('compares %s to %s', (left, right, expected) => {
    expect(compareSemVer(left, right)).toBe(expected);
  });
  it('uses the same closed candidate URL shape in the reusable UI service', () => {
    const url=`https://raw.githubusercontent.com/kody-w/openrappter/${'b'.repeat(40)}/candidates/${'a'.repeat(40)}/release/tag-djEuMTMuMA/${'c'.repeat(64)}.tar.gz`;
    expect(parseCandidateBundleUrl(url)).toMatchObject({kind:'release',candidateId:'tag-djEuMTMuMA'});
    expect(() => parseCandidateBundleUrl(`${url}?mutable=1`)).toThrow();
    expect(() => parseCandidateBundleUrl(url.replace('raw.githubusercontent.com', 'raw.githubusercontent.com:443'))).toThrow();
    expect(() => parseCandidateBundleUrl(`${url}\n`)).toThrow();
    expect(() => parseCandidateBundleUrl(url.replace('/release/tag-djEuMTMuMA', ''))).toThrow();
  });
});

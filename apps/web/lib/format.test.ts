import { describe, expect, it } from 'vitest';
import { EMAIL_RE, parseLeadFile } from './format';

describe('parseLeadFile', () => {
  it('reads addresses from a CSV with headers, quotes and extra columns', () => {
    const csv =
      'name,email,company\n"Ann","Ann@Example.com",Acme\nBob,bob@example.org,"Foo, Inc"\n';
    expect(parseLeadFile(csv)).toEqual(['ann@example.com', 'bob@example.org']);
  });

  it('reads addresses from plain text split by lines, commas, semicolons or spaces', () => {
    expect(parseLeadFile('a@x.io; b@x.io, c@x.io\nd@x.io e@x.io')).toEqual([
      'a@x.io',
      'b@x.io',
      'c@x.io',
      'd@x.io',
      'e@x.io',
    ]);
  });

  it('removes duplicates, ignoring case', () => {
    expect(parseLeadFile('A@x.io\na@x.io\nA@X.IO')).toEqual(['a@x.io']);
  });

  it('returns nothing when there is no address', () => {
    expect(parseLeadFile('name,company\nAnn,Acme')).toEqual([]);
    expect(parseLeadFile('')).toEqual([]);
  });

  it('handles Windows line endings and a byte-order mark', () => {
    expect(parseLeadFile('﻿email\r\na@x.io\r\nb@x.io\r\n')).toEqual(['a@x.io', 'b@x.io']);
  });
});

describe('EMAIL_RE', () => {
  it('accepts normal and rejects broken addresses', () => {
    expect(EMAIL_RE.test('a@x.io')).toBe(true);
    expect(EMAIL_RE.test('bad-address')).toBe(false);
    expect(EMAIL_RE.test('a@x')).toBe(false);
  });
});

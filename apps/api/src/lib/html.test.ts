import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeEmailHtml } from './html.js';

describe('email html', () => {
  it('removes scripts, handlers and javascript: links', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">l</a></p>',
    );
    expect(out).not.toMatch(/script|onclick|javascript:/i);
    expect(out).toContain('Hi');
  });
  it('keeps formatting tags', () => {
    expect(sanitizeEmailHtml('<b>a</b><ul><li>b</li></ul>')).toBe('<b>a</b><ul><li>b</li></ul>');
  });
  it('converts to text with line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three');
  });
});

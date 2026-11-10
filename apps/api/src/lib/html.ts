import sanitizeHtml from 'sanitize-html';

/** Tags the compose editor can produce. Everything else is dropped. */
const ALLOWED_TAGS = [
  'p',
  'div',
  'span',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'font',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'h1',
  'h2',
  'h3',
  'hr',
];

/** Strips scripts, handlers, and unsafe URLs from user-authored email HTML. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      font: ['size'],
      '*': ['style'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        'margin-left': [/^\d+(px|em)$/],
        'padding-left': [/^\d+(px|em)$/],
        'font-size': [/^\d+(px|em|pt)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  });
}

/** Plain-text rendition: used for the multipart text part and search indexing. */
export function htmlToText(html: string): string {
  return sanitizeHtml(html.replace(/<\/(p|div|li|blockquote|h[1-3])>|<br\s*\/?>/gi, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escapes text for use inside HTML element content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

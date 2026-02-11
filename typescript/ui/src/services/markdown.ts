/**
 * Markdown rendering with sanitization.
 * Uses marked for parsing and DOMPurify for XSS protection.
 */

import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const marked = new Marked({
  breaks: true,
  gfm: true,
});

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div',
  'img', 'sup', 'sub',
];

const ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'src', 'alt', 'title'];

export function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ['target'],
  });
}

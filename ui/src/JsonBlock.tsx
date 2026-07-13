import type { CSSProperties } from 'react';
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('json', json);

interface Props {
  value: unknown;
  style?: CSSProperties;
}

// Renders a <pre> with JSON syntax highlighting. Non-string values are always
// treated as JSON (they came from JSON.stringify). Strings are only
// highlighted when they actually parse as JSON, since previews of captured
// bodies may be plain text, form-encoded, etc.
export function JsonBlock({ value, style }: Props): JSX.Element {
  if (typeof value === 'string') {
    const highlighted = highlightIfJson(value);
    return highlighted === null
      ? <pre style={style}>{value}</pre>
      : <pre className="hljs" style={style} dangerouslySetInnerHTML={{ __html: highlighted }} />;
  }
  if (value === undefined || value === null) return <pre style={style} />;
  const text = JSON.stringify(value, null, 2);
  return <pre className="hljs" style={style} dangerouslySetInnerHTML={{ __html: hljs.highlight(text, { language: 'json' }).value }} />;
}

function highlightIfJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  return hljs.highlight(text, { language: 'json' }).value;
}

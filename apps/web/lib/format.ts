const time = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const weekday = new Intl.DateTimeFormat('en', { weekday: 'short' });
const fullDate = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const longDate = new Intl.DateTimeFormat('en', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** List pill: "Tue 9:15:12 AM". */
export const pillTime = (value: string) => {
  const d = new Date(value);
  return `${weekday.format(d)} ${time.format(d)}`;
};
/** Detail header: "Nov 3, 10:23 AM". */
export const shortDate = (value: string) => fullDate.format(new Date(value));
export const fullDateTime = (value: string) => longDate.format(new Date(value));

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export function parseLeadFile(text: string) {
  const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(found.map((address) => address.toLowerCase()))];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

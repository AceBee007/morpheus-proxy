// Client-side timezone handling for log timestamp display.
// The server always sends UTC ISO 8601 strings; every conversion to a
// human-facing timezone happens here, in the browser.

const STORAGE_KEY = 'morpheus.timezone';

const FALLBACK_TIME_ZONES = [
  'UTC',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function detectBrowserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    /* Intl unavailable or misconfigured */
  }
  return 'UTC';
}

export function getStoredTimeZone(): string | null {
  try {
    const tz = localStorage.getItem(STORAGE_KEY);
    return tz && isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

export function setStoredTimeZone(tz: string | null): void {
  try {
    if (tz) localStorage.setItem(STORAGE_KEY, tz);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode / quota) - setting stays session-only */
  }
}

/** LocalStorage -> browser inference -> UTC (in that order). */
export function resolveTimeZone(): string {
  return getStoredTimeZone() ?? detectBrowserTimeZone();
}

export function listSupportedTimeZones(): string[] {
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      /* fall through to curated list */
    }
  }
  return FALLBACK_TIME_ZONES;
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  // Locale fixed to en-US so fields come back as plain ASCII digits
  // regardless of the browser's own locale (e.g. avoids Arabic-indic digits).
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function extractSeq(id: string): number {
  const tail = /-(\d+)$/.exec(id);
  return tail ? Number(tail[1]) : 0;
}

/**
 * Formats a log entry's timestamp as `YYYY/MM/DD-HH:MM:SS.sss-nnnnn` in the
 * given IANA timezone. `nnnnn` is the log's own sequence number (the trailing
 * digits of its id, which are unique and monotonic per server process),
 * disambiguating entries that share the same millisecond.
 */
export function formatLogTimestamp(startedAtIso: string, id: string, timeZone: string): string {
  const date = new Date(startedAtIso);
  if (Number.isNaN(date.getTime())) return startedAtIso;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = partsFormatter(timeZone);
  } catch {
    formatter = partsFormatter('UTC');
  }

  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  // Milliseconds-within-the-second are timezone-invariant (offsets are whole minutes).
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  const seq = String(extractSeq(id)).padStart(5, '0');

  return `${get('year')}/${get('month')}/${get('day')}-${get('hour')}:${get('minute')}:${get('second')}.${ms}-${seq}`;
}

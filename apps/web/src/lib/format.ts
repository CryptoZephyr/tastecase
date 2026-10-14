// dateStyle/timeStyle can't be combined with timeZoneName, so the components are explicit.
const dateTime = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export function formatDateTime(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(date.getTime()) ? 'Unknown time' : dateTime.format(date);
}
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : dateOnly.format(date);
}
export function formatClock(date: Date): string {
  return timeOnly.format(date);
}

/** Short visual form for checksums/IDs. Always pair with a way to read or copy the full value. */
export function shortHash(value: string, length = 12): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function formatMoney(amountMinor: number, currency: string): string {
  try {
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor} ${currency} (minor units)`;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function profileLabel(profileId: 'a' | 'b'): string {
  return profileId === 'a' ? 'Profile A' : 'Profile B';
}

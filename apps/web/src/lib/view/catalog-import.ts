import type { CatalogEntry } from '@/lib/api/types';

export interface ImportIssue { line: string; message: string }
export type CatalogParse = { ok: true; entries: CatalogEntry[] } | { ok: false; issues: ImportIssue[] };

const ENTRY_KEYS = new Set(['id', 'name', 'metadata', 'constraintFacts', 'qlooEntityId']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Early, readable checks for the catalog contract (CatalogEntrySchema). The API remains the
 * authority and re-validates strictly; this only catches common mistakes before submission.
 */
export function parseCatalogJson(text: string): CatalogParse {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, issues: [{ line: 'File', message: 'This isn’t valid JSON.' }] }; }
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { entries?: unknown }).entries) ? (value as { entries: unknown[] }).entries : null;
  if (!list) return { ok: false, issues: [{ line: 'File', message: 'Provide an array of restaurants, or an object with an "entries" array.' }] };
  if (list.length === 0) return { ok: false, issues: [{ line: 'File', message: 'Add at least one restaurant.' }] };
  if (list.length > 500) return { ok: false, issues: [{ line: 'File', message: `A catalog version holds at most 500 restaurants; this file has ${list.length}.` }] };
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const line = `Restaurant ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { issues.push({ line, message: 'Must be an object.' }); return; }
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const label = id ? `${line} (${id})` : line;
    if (!id || id.length > 160) issues.push({ line: label, message: '"id" must be text of 1–160 characters.' });
    else if (seen.has(id)) issues.push({ line: label, message: 'Duplicate "id"; each restaurant needs a stable, unique ID.' });
    seen.add(id);
    if (!name || name.length > 160) issues.push({ line: label, message: '"name" must be text of 1–160 characters.' });
    if (entry.qlooEntityId !== undefined && (typeof entry.qlooEntityId !== 'string' || !UUID.test(entry.qlooEntityId))) issues.push({ line: label, message: '"qlooEntityId" must be a UUID when present. It is a candidate, not a confirmation.' });
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) issues.push({ line: label, message: `Unsupported field "${key}". Allowed: id, name, metadata, constraintFacts, qlooEntityId.` });
    for (const key of ['metadata', 'constraintFacts'] as const) if (entry[key] !== undefined && (typeof entry[key] !== 'object' || entry[key] === null || Array.isArray(entry[key]))) issues.push({ line: label, message: `"${key}" must be an object when present.` });
  });
  if (issues.length) return { ok: false, issues };
  return { ok: true, entries: list as CatalogEntry[] };
}

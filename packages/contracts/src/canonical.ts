import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Canonical v1 JSON: sorted object keys (UTF-16), ordered arrays and JSON scalar encoding.
 * Rejects non-JSON values, sparse arrays, cycles and non-plain objects rather than losing data.
 * No Unicode normalisation is performed; callers hash validated schema outputs.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON requires finite numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Canonical JSON requires JSON values');
    if (ancestors.has(item)) throw new TypeError('Canonical JSON cannot contain cycles');
    ancestors.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length > 0) throw new TypeError('Canonical JSON cannot contain symbol keys');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).length !== item.length + 1) throw new TypeError('Canonical JSON requires dense arrays without extra properties');
        const items = Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON requires array data properties');
          return encode(descriptor.value);
        });
        return `[${items.join(',')}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new TypeError('Canonical JSON requires plain objects');
      }
      const keys = Object.keys(descriptors).sort();
      if (keys.some(key => !descriptors[key].enumerable || !('value' in descriptors[key]))) {
        throw new TypeError('Canonical JSON requires enumerable data properties');
      }
      return `{${keys.map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

/** Lowercase SHA-256 hex of UTF-8 canonical JSON, not Postgres jsonb text. */
export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

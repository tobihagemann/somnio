import confusablesJSON from '../../data/name-policy/confusables.json' with { type: 'json' };
import generalCategoriesJSON from '../../data/name-policy/general-categories.json' with { type: 'json' };
import identifierProfileJSON from '../../data/name-policy/identifier-profile.json' with { type: 'json' };
import scriptsJSON from '../../data/name-policy/scripts.json' with { type: 'json' };
import versionJSON from '../../data/name-policy/version.json' with { type: 'json' };

/**
 * The committed Unicode tables behind the name policy, parsed once on first import. The data
 * ships as compact `;`-delimited strings (the generator's output) and is looked up through
 * binary-searched sorted ranges.
 */

/**
 * Sorted, non-overlapping `[start, end] -> value` ranges with a binary-search lookup. Each entry
 * is `start end[ value]` in hex code points; `parseValue` decodes the optional third field.
 */
class RangeTable<T> {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly values: T[] = [];

  constructor(encoded: string, parseValue: (field: string) => T) {
    for (const entry of encoded.split(';')) {
      const fields = entry.split(' ');
      const start = parseInt(fields[0] ?? '', 16);
      const end = parseInt(fields[1] ?? '', 16);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      this.starts.push(start);
      this.ends.push(end);
      this.values.push(parseValue(fields[2] ?? ''));
    }
  }

  value(scalar: number): T | undefined {
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (scalar < this.starts[mid]!) high = mid - 1;
      else if (scalar > this.ends[mid]!) low = mid + 1;
      else return this.values[mid];
    }
    return undefined;
  }
}

/** TR39 confusable prototype map: a source scalar maps to one or more target scalars. */
export const CONFUSABLES: ReadonlyMap<number, readonly number[]> = parseConfusables(confusablesJSON.mappingTable);

/** `;`-separated canonical (long) script names; the array index is the script id. */
const SCRIPT_NAMES: readonly string[] = scriptsJSON.scriptNames.split(';');

export const UNICODE_DATA_VERSION_OF_TABLES: string = versionJSON.unicode;

const primaryScript = new RangeTable(scriptsJSON.scriptRanges, (field) => Number(field));
const scriptExtensions = new RangeTable(scriptsJSON.scriptExtensionRanges, (field) => field.split(',').map((id) => Number(id)));
const allowed = new RangeTable(identifierProfileJSON.allowedRanges, () => true);
const generalCategory = new RangeTable(generalCategoriesJSON.ranges, (field) => field);

export function scriptID(name: string): number | undefined {
  const index = SCRIPT_NAMES.indexOf(name);
  return index === -1 ? undefined : index;
}

/** The Script_Extensions set for a scalar, falling back to its primary Script; empty when unassigned. */
export function scriptSet(scalar: number): Set<number> {
  const extensions = scriptExtensions.value(scalar);
  if (extensions !== undefined) return new Set(extensions);
  const primary = primaryScript.value(scalar);
  return primary === undefined ? new Set() : new Set([primary]);
}

export function isAllowed(scalar: number): boolean {
  return allowed.value(scalar) === true;
}

/** The General_Category of a scalar among the name-shape categories, or `undefined` for any other. */
export function nameShapeCategory(scalar: number): string | undefined {
  return generalCategory.value(scalar);
}

function parseConfusables(encoded: string): Map<number, readonly number[]> {
  const map = new Map<number, readonly number[]>();
  for (const entry of encoded.split(';')) {
    const separator = entry.indexOf('>');
    if (separator === -1) continue;
    const source = parseInt(entry.slice(0, separator), 16);
    const targets = entry
      .slice(separator + 1)
      .split(' ')
      .map((token) => parseInt(token, 16))
      .filter((value) => !Number.isNaN(value));
    if (Number.isNaN(source) || targets.length === 0) continue;
    map.set(source, targets);
  }
  return map;
}

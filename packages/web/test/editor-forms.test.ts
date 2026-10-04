import { describe, expect, it } from 'vitest';
import { setSelectValue } from '@/editor/ui/editorDom';
import { MAX_SECTOR_NAME_BYTES, isValidSectorName } from '@/editor/sectorName';
import { SectorForm, validationMessage } from '@/editor/ui/sectorForm';

/**
 * Form and select integrity for the editor's New Map / Sector Settings surfaces: the sector-name
 * policy the form and the file middleware share, the size and origin gates, the rows each sector
 * kind asks for, and the picker's preservation of a registry id the model pack no longer maps.
 */

describe('isValidSectorName', () => {
  it('accepts spaces and non-ASCII, rejects separators, NUL, and dot-prefixes', () => {
    expect(isValidSectorName('Nordwiese Süd')).toBe(true);
    expect(isValidSectorName('')).toBe(false);
    expect(isValidSectorName('.hidden')).toBe(false);
    expect(isValidSectorName('foo/bar')).toBe(false);
    expect(isValidSectorName('foo\\bar')).toBe(false);
    expect(isValidSectorName('foo\u0000bar')).toBe(false);
  });

  it('bounds the UTF-8 byte length so the file API never hits ENAMETOOLONG', () => {
    expect(isValidSectorName('a'.repeat(MAX_SECTOR_NAME_BYTES))).toBe(true);
    expect(isValidSectorName('a'.repeat(MAX_SECTOR_NAME_BYTES + 1))).toBe(false);
    // Multi-byte characters count by encoded bytes, not code points.
    expect(isValidSectorName('ü'.repeat(MAX_SECTOR_NAME_BYTES))).toBe(false);
  });
});

describe('validationMessage', () => {
  const base = { name: 'Room', kind: 'outdoor', width: 20, depth: 20, originX: 0, originZ: 0, brightness: 100, floorMaterialId: 'grass' } as const;

  it.each([
    ['a valid outdoor sector', {}, undefined],
    ['an empty name', { name: '' }, 'Fill in sector name!'],
    ['a name the file API refuses', { name: 'a/b' }, 'Invalid sector name!'],
    ['no extent', { depth: 0 }, 'Invalid sector size!'],
    ['an unparseable extent', { width: Number.NaN }, 'Invalid sector size!'],
    ['an extent past the protocol cap', { width: 512.01 }, 'Invalid sector size!'],
    ['an extent at the protocol cap', { width: 512 }, undefined],
    ['an outdoor sector the camera would see past', { depth: 15.99 }, 'An outdoor sector is at least 16 m wide and deep!'],
    ['an interior of the same size', { kind: 'interior', depth: 15.99 }, undefined],
    ['an origin past the coordinate cap', { originZ: -10_000.5 }, 'Invalid sector origin!'],
    ['an interior, whose origin is not asked for', { kind: 'interior', originZ: -10_000.5 }, undefined],
  ] as const)('judges %s', (_name, overrides, message) => {
    expect(validationMessage({ ...base, ...overrides })).toBe(message);
  });
});

describe('SectorForm', () => {
  function rowOf(form: SectorForm, label: string): HTMLElement {
    const node = [...form.root.querySelectorAll('label')].find((candidate) => candidate.textContent === label);
    return node!.parentElement!;
  }

  it('reads back the values it was given', () => {
    const form = new SectorForm(['grass', 'cobble'], () => {});
    const values = {
      name: 'Nordwiese',
      kind: 'outdoor',
      width: 30.72,
      depth: 30.72,
      originX: 5.12,
      originZ: -30.72,
      brightness: 100,
      floorMaterialId: 'cobble',
    } as const;
    form.setValues(values);
    expect(form.values()).toEqual(values);
  });

  it('asks for an origin outdoors and a brightness in an interior, following the kind picker', () => {
    const form = new SectorForm(['grass'], () => {});
    const hidden = (label: string): boolean => rowOf(form, label).classList.contains('hidden');
    expect([hidden('Origin X (m)'), hidden('Origin Z (m)'), hidden('Light')]).toEqual([false, false, true]);
    const kind = rowOf(form, 'Kind').querySelector('select')!;
    kind.value = 'interior';
    kind.dispatchEvent(new Event('change'));
    expect([hidden('Origin X (m)'), hidden('Origin Z (m)'), hidden('Light')]).toEqual([true, true, false]);
    expect(form.values().kind).toBe('interior');
  });

  it('clamps a hand-typed brightness to a whole percentage', () => {
    const form = new SectorForm(['grass'], () => {});
    const light = rowOf(form, 'Light').querySelector('input')!;
    for (const [typed, expected] of [
      ['140', 100],
      ['-3', 0],
      ['55.5', 100],
      ['40', 40],
    ] as const) {
      light.value = typed;
      expect(form.values().brightness).toBe(expected);
    }
  });
});

describe('setSelectValue', () => {
  function selectWith(...values: string[]): HTMLSelectElement {
    const select = document.createElement('select');
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      select.append(option);
    }
    return select;
  }

  it('selects a matching option normally', () => {
    const select = selectWith('grass', 'stone');
    setSelectValue(select, 'stone');
    expect(select.value).toBe('stone');
    expect(select.options.length).toBe(2);
  });

  it('preserves an unmapped id by appending an option instead of blanking', () => {
    const select = selectWith('grass', 'stone');
    setSelectValue(select, 'legacy-floor');
    expect(select.value).toBe('legacy-floor');
    expect(select.options.length).toBe(3);
  });

  it('does not accumulate options when the same unmapped id is set repeatedly', () => {
    const select = selectWith('grass', 'stone');
    setSelectValue(select, 'legacy-floor');
    setSelectValue(select, 'grass');
    setSelectValue(select, 'legacy-floor');
    expect(select.value).toBe('legacy-floor');
    // The unmapped option is added once and reused, not appended on every set.
    expect(select.options.length).toBe(3);
  });
});

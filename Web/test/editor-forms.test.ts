import { describe, expect, it } from 'vitest'
import { setSelectValue } from '@/ui/dom'
import { MAX_SECTOR_NAME_BYTES, isValidSectorName } from '@/editor/sectorName'
import { validationMessage } from '@/editor/ui/sectorForm'

/**
 * Form and select integrity for the editor's New Map / Sector Settings surfaces: the sector-name
 * policy the form and the file middleware share, and the picker's preservation of a registry id
 * the model pack no longer maps.
 */

describe('isValidSectorName', () => {
  it('accepts spaces and non-ASCII, rejects separators, NUL, and dot-prefixes', () => {
    expect(isValidSectorName('Nordwiese Süd')).toBe(true)
    expect(isValidSectorName('')).toBe(false)
    expect(isValidSectorName('.hidden')).toBe(false)
    expect(isValidSectorName('foo/bar')).toBe(false)
    expect(isValidSectorName('foo\\bar')).toBe(false)
    expect(isValidSectorName('foo\u0000bar')).toBe(false)
  })

  it('bounds the UTF-8 byte length so the file API never hits ENAMETOOLONG', () => {
    expect(isValidSectorName('a'.repeat(MAX_SECTOR_NAME_BYTES))).toBe(true)
    expect(isValidSectorName('a'.repeat(MAX_SECTOR_NAME_BYTES + 1))).toBe(false)
    // Multi-byte characters count by encoded bytes, not code points.
    expect(isValidSectorName('ü'.repeat(MAX_SECTOR_NAME_BYTES))).toBe(false)
  })
})

describe('validationMessage', () => {
  const base = { width: 4, height: 4, indoor: false, brightness: 100, floorMaterialID: 'grass' }

  it('gates on name and size, passing a valid form', () => {
    expect(validationMessage({ ...base, name: 'Room' })).toBeUndefined()
    expect(validationMessage({ ...base, name: '' })).toBe('Fill in sector name!')
    expect(validationMessage({ ...base, name: 'a/b' })).toBe('Invalid sector name!')
    expect(validationMessage({ ...base, name: 'Room', width: 4096 })).toBe('Invalid sector size!')
  })
})

describe('setSelectValue', () => {
  function selectWith(...values: string[]): HTMLSelectElement {
    const select = document.createElement('select')
    for (const value of values) {
      const option = document.createElement('option')
      option.value = value
      select.append(option)
    }
    return select
  }

  it('selects a matching option normally', () => {
    const select = selectWith('grass', 'stone')
    setSelectValue(select, 'stone')
    expect(select.value).toBe('stone')
    expect(select.options.length).toBe(2)
  })

  it('preserves an unmapped id by appending an option instead of blanking', () => {
    const select = selectWith('grass', 'stone')
    setSelectValue(select, 'legacy-floor')
    expect(select.value).toBe('legacy-floor')
    expect(select.options.length).toBe(3)
  })

  it('does not accumulate options when the same unmapped id is set repeatedly', () => {
    const select = selectWith('grass', 'stone')
    setSelectValue(select, 'legacy-floor')
    setSelectValue(select, 'grass')
    setSelectValue(select, 'legacy-floor')
    expect(select.value).toBe('legacy-floor')
    // The unmapped option is added once and reused, not appended on every set.
    expect(select.options.length).toBe(3)
  })
})

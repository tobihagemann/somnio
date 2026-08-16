import { describe, expect, it } from 'vitest'
import { reseeded } from '@/editor/ui/inspectorDraft'

/**
 * The reseed rule shared by every inspector field. Values arrive pre-rendered to strings, so
 * the "rendering" cases pass renderings directly.
 */
describe('reseeded', () => {
  it('always follows the document while unfocused', () => {
    expect(reseeded('300', false, '256', '300')).toBe('300')
  })

  it('follows the document while unfocused even when the draft already matches', () => {
    expect(reseeded('256', false, '256', '300')).toBe('300')
  })

  it('follows the document for an untouched focused draft', () => {
    expect(reseeded('256', true, '256', '300')).toBe('300')
  })

  it('preserves a focused draft the user has typed into', () => {
    expect(reseeded('30', true, '256', '300')).toBeUndefined()
  })

  it('compares against the departing value, not the arriving one', () => {
    // The arriving value never equals the draft mid-change, so keying on it would reseed
    // nothing while focused.
    expect(reseeded('300', true, '256', '300')).toBeUndefined()
  })

  it('counts a draft matching the committed rendering as untouched', () => {
    // A non-integer field is seeded from the value's rendering, so the untouched test has
    // to compare renderings too ("270.0" vs "270").
    expect(reseeded('270.0', true, '270.0', '90.0')).toBe('90.0')
    expect(reseeded('270', true, '270.0', '90.0')).toBeUndefined()
  })

  it('compares a string-valued field text directly', () => {
    expect(reseeded('Hallo', true, 'Hallo', 'Servus')).toBe('Servus')
    expect(reseeded('Hall', true, 'Hallo', 'Servus')).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../src/repositories/errors.ts'

const constraints: ReadonlySet<string> = new Set(['accounts_name_key'])

/** The one gate between "the name is taken" and every other database failure a registration can hit. */
describe('isUniqueViolation', () => {
  it('matches a 23505 on a listed constraint', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'accounts_name_key' }, constraints)).toBe(true)
  })

  it.each([
    ['a 23505 on an unlisted constraint', { code: '23505', constraint: 'sessions_pkey' }],
    ['a 23505 without a constraint name', { code: '23505' }],
    ['another SQLSTATE on a listed constraint', { code: '23503', constraint: 'accounts_name_key' }],
    ['a plain Error', new Error('23505')],
    ['a string', '23505'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, error) => {
    expect(isUniqueViolation(error, constraints)).toBe(false)
  })
})

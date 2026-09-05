/** A row-mapping failure: raw column data that cannot be lifted into a domain enum or value. */
export class RepositoryDecodingError extends Error {
  readonly field: string
  readonly rawValue: number

  constructor(field: string, rawValue: number) {
    super(`invalid ${field} raw value ${rawValue}`)
    this.name = 'RepositoryDecodingError'
    this.field = field
    this.rawValue = rawValue
  }
}

/** The `pg` driver's error shape for a constraint violation. */
export interface PgConstraintError {
  code?: string
  constraint?: string
}

export function isUniqueViolation(error: unknown, constraints: ReadonlySet<string>): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as PgConstraintError
  return (
    candidate.code === '23505' && candidate.constraint !== undefined && constraints.has(candidate.constraint)
  )
}

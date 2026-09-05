/** Surfaced by the admin `version` verb; the image stamps it from `BUILD_VERSION` (the commit's short sha). */
export const SERVER_VERSION: string = process.env['SOMNIO_SERVER_VERSION'] ?? '0.0.0-dev'

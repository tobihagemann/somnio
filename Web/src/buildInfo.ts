/**
 * Build identity, injected by `vite.config.ts` through an explicit `define`.
 *
 * `SOMNIO_BUILD_STAMP` interpolates the injected constant **directly** rather than reusing
 * `SOMNIO_WEB_VERSION`. That looks redundant and is not: `SOMNIO_WEB_VERSION` is an exported
 * binding other modules read, so the minifier keeps it as a variable and the template literal comes
 * out as `somnio-web ${Xh}` instead of a folded string. Interpolating the define means both halves
 * are constants at fold time, so the literal survives into the bundle — which is what the image
 * build greps for to prove the version was injected at all.
 *
 * The marker prefix is load-bearing for the same reason: a bare version number would also match
 * version strings inside dependencies. String literals are the one thing minification never
 * renames.
 */
export const SOMNIO_WEB_VERSION: string = __SOMNIO_WEB_VERSION__

/** The literal the image build greps for. Also surfaced on `<html data-somnio-build>`. */
export const SOMNIO_BUILD_STAMP = `somnio-web ${__SOMNIO_WEB_VERSION__}`

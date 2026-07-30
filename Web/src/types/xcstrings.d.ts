/**
 * `resolveJsonModule` only covers `.json`, and the catalogs keep their Xcode extension. The Vite
 * plugin in `vite.config.ts` turns them into JSON modules at load time; this declares the shape so
 * the compiler agrees with what the plugin produces.
 */
declare module '@catalog/core' {
  import type { Xcstrings } from '@/i18n/xcstrings'
  const catalog: Xcstrings
  export default catalog
}

declare module '@catalog/ui' {
  import type { Xcstrings } from '@/i18n/xcstrings'
  const catalog: Xcstrings
  export default catalog
}

declare module '@catalog/app' {
  import type { Xcstrings } from '@/i18n/xcstrings'
  const catalog: Xcstrings
  export default catalog
}

import type { CatalogTables } from './xcstrings'

/**
 * Strings the browser client renders that exist in none of the Swift catalogs, because the native
 * client never had the problem: it bundles its assets, owns its window, keeps credentials in the
 * Keychain, and cannot be opened on a phone.
 *
 * Authored here in the same shape the Swift catalogs flatten to, so the merge treats all four
 * sources identically and the allowlist test cannot tell them apart. Keys stay English source
 * strings, matching the `.xcstrings` convention, and use ASCII `...` per the repo's ellipsis rule.
 */
export const browserCatalog: CatalogTables = {
  en: {
    'This browser cannot render 3D graphics.': 'This browser cannot render 3D graphics.',
    'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox on a desktop computer.':
      'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox on a desktop computer.',
    'Somnio needs a desktop computer.': 'Somnio needs a desktop computer.',
    'The game is played with a keyboard and a mouse. Come back from a laptop or desktop.':
      'The game is played with a keyboard and a mouse. Come back from a laptop or desktop.',
    'Loading the world...': 'Loading the world...',
    Fullscreen: 'Fullscreen',
    'Your session expired. Please log in again.': 'Your session expired. Please log in again.',
    'Reconnecting...': 'Reconnecting...',
  },
  de: {
    'This browser cannot render 3D graphics.': 'Dieser Browser kann keine 3D-Grafik darstellen.',
    'Somnio needs WebGL. Try a current version of Safari, Chrome, or Firefox on a desktop computer.':
      'Somnio benötigt WebGL. Probiere eine aktuelle Version von Safari, Chrome oder Firefox auf einem Desktop-Rechner.',
    'Somnio needs a desktop computer.': 'Somnio benötigt einen Desktop-Rechner.',
    'The game is played with a keyboard and a mouse. Come back from a laptop or desktop.':
      'Das Spiel wird mit Tastatur und Maus gespielt. Komm von einem Laptop oder Desktop-Rechner zurück.',
    'Loading the world...': 'Welt wird geladen...',
    Fullscreen: 'Vollbild',
    'Your session expired. Please log in again.': 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
    'Reconnecting...': 'Verbindung wird wiederhergestellt...',
  },
}

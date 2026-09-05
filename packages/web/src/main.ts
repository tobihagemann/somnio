import './ui/chrome.css'
import { AppShell } from '@/ui/appShell'
import { installDebugAPI } from '@/debugApi'
import { SOMNIO_BUILD_STAMP, SOMNIO_WEB_VERSION } from '@/buildInfo'
import { resolveLocale } from '@/i18n'

const container = document.querySelector<HTMLElement>('#somnio-root')
if (container === null) throw new Error('#somnio-root is missing from index.html')

// Readable without the debug API and without `?debug=1`, so any loaded page identifies its build.
// Set here rather than in `index.html` because the version reaches the bundle through Vite's
// `define` — which means it appears only once this module runs, so a `curl` of the served document
// shows nothing and the stamp has to be read from the live DOM.
document.documentElement.dataset.somnioBuild = SOMNIO_BUILD_STAMP
// The document language has to follow the rendered strings: every panel and chat line comes from the
// German table when the browser asks for German, and a stale `lang="en"` makes a screen reader
// pronounce them with English phonetics.
document.documentElement.lang = resolveLocale()

const shell = new AppShell({ container, appVersion: SOMNIO_WEB_VERSION })

installDebugAPI(shell, { isDevelopment: import.meta.env.DEV })

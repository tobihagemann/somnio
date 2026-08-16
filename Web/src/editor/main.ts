import '@/ui/chrome.css'
import './ui/editor.css'
import { EditorShell } from './editorShell'
import { installEditorDebugAPI } from './debugApi'

/**
 * The editor entry. English-only by decision: no `@/i18n` import anywhere under
 * `src/editor/`, which is what keeps the catalog allowlists and their tests untouched.
 */
const container = document.querySelector<HTMLElement>('#somnio-editor-root')
if (container === null) throw new Error('#somnio-editor-root is missing from editor.html')

document.documentElement.lang = 'en'

const shell = new EditorShell({ container })
installEditorDebugAPI(shell)

/**
 * The editor's keyboard command surface, a menu-bar stand-in: `⌘S` Save, `⇧⌘S` Save As (a
 * prompt overlay collects the name; there is no native File menu), `⌘Z`/`⇧⌘Z` Undo/Redo,
 * `⌘D` Duplicate Selection, `⌘G` Grid, `⌘C`/`⌘V` copy/paste, `⌘A` Select All,
 * Delete/Backspace, and the four arrow keys for nudge.
 *
 * Bound on `metaKey || ctrlKey` so the editor works on Linux. Escape is handled first and is
 * never suppressed (it backs out overlays and clears selection); every other binding is
 * suppressed while a text field has focus, and also while an overlay is up.
 */

export interface EditorCommandTarget {
  isOverlayPresented(): boolean
  handleEscape(): void
  save(): void
  presentSaveAs(): void
  undo(): void
  redo(): void
  duplicateSelection(): void
  toggleGrid(): void
  copySelection(): void
  paste(): void
  selectAll(): void
  deleteSelection(): void
  nudgeSelection(key: string, shiftHeld: boolean): boolean
}

export function handleEditorKeydown(target: EditorCommandTarget, event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    target.handleEscape()
    return
  }
  if (isTextEntryFocused()) return

  const command = event.metaKey || event.ctrlKey
  if (command) {
    switch (event.key.toLowerCase()) {
      case 's':
        event.preventDefault()
        if (target.isOverlayPresented()) return
        if (event.shiftKey) target.presentSaveAs()
        else target.save()
        return
      case 'z':
        event.preventDefault()
        if (target.isOverlayPresented()) return
        if (event.shiftKey) target.redo()
        else target.undo()
        return
      case 'd':
        event.preventDefault()
        if (target.isOverlayPresented()) return
        target.duplicateSelection()
        return
      case 'g':
        event.preventDefault()
        if (target.isOverlayPresented()) return
        target.toggleGrid()
        return
      case 'c':
        if (target.isOverlayPresented()) return
        event.preventDefault()
        target.copySelection()
        return
      case 'v':
        if (target.isOverlayPresented()) return
        event.preventDefault()
        target.paste()
        return
      case 'a':
        if (target.isOverlayPresented()) return
        event.preventDefault()
        target.selectAll()
        return
      default:
        return
    }
  }

  if (target.isOverlayPresented()) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    target.deleteSelection()
    return
  }
  if (target.nudgeSelection(event.key, event.shiftKey)) {
    event.preventDefault()
  }
}

function isTextEntryFocused(): boolean {
  const active = document.activeElement
  if (active === null) return false
  const tag = active.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

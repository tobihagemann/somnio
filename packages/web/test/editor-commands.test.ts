import { afterEach, describe, expect, it } from 'vitest'
import { type EditorCommandTarget, handleEditorKeydown } from '@/editor/commands'

/**
 * The keyboard command router — a menu-bar stand-in, and the
 * one surface every command reaches the shell through. Pins the routing rules a refactor would
 * flatten silently: Escape's exemption from the focus gate, the meta/ctrl fallback for Linux,
 * text-focus suppression, overlay gating, and arrow-nudge's handled-vs-unhandled preventDefault.
 */

class RecordingTarget implements EditorCommandTarget {
  calls: string[] = []
  overlayPresented = false
  nudgeHandled = true
  isOverlayPresented(): boolean {
    return this.overlayPresented
  }
  handleEscape(): void {
    this.calls.push('escape')
  }
  save(): void {
    this.calls.push('save')
  }
  presentSaveAs(): void {
    this.calls.push('saveAs')
  }
  undo(): void {
    this.calls.push('undo')
  }
  redo(): void {
    this.calls.push('redo')
  }
  duplicateSelection(): void {
    this.calls.push('duplicate')
  }
  toggleGrid(): void {
    this.calls.push('grid')
  }
  copySelection(): void {
    this.calls.push('copy')
  }
  paste(): void {
    this.calls.push('paste')
  }
  selectAll(): void {
    this.calls.push('selectAll')
  }
  deleteSelection(): void {
    this.calls.push('delete')
  }
  nudgeSelection(): boolean {
    this.calls.push('nudge')
    return this.nudgeHandled
  }
}

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

function focusTextEntry(): void {
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('handleEditorKeydown', () => {
  it('routes each meta-modified key to its command, preventing the browser default', () => {
    const cases: [KeyboardEventInit, string][] = [
      [{ key: 's', metaKey: true }, 'save'],
      [{ key: 's', metaKey: true, shiftKey: true }, 'saveAs'],
      [{ key: 'z', metaKey: true }, 'undo'],
      [{ key: 'z', metaKey: true, shiftKey: true }, 'redo'],
      [{ key: 'd', metaKey: true }, 'duplicate'],
      [{ key: 'g', metaKey: true }, 'grid'],
      [{ key: 'c', metaKey: true }, 'copy'],
      [{ key: 'v', metaKey: true }, 'paste'],
      [{ key: 'a', metaKey: true }, 'selectAll'],
    ]
    for (const [init, expected] of cases) {
      const target = new RecordingTarget()
      const event = press(init)
      handleEditorKeydown(target, event)
      expect(target.calls).toEqual([expected])
      expect(event.defaultPrevented).toBe(true)
    }
  })

  it('accepts ctrlKey as the modifier too, for Linux', () => {
    const target = new RecordingTarget()
    handleEditorKeydown(target, press({ key: 's', ctrlKey: true }))
    expect(target.calls).toEqual(['save'])
  })

  it('handles Escape before the focus gate and never suppresses it', () => {
    const target = new RecordingTarget()
    focusTextEntry()
    const event = press({ key: 'Escape' })
    handleEditorKeydown(target, event)
    expect(target.calls).toEqual(['escape'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('suppresses every non-Escape binding while a text field has focus', () => {
    const target = new RecordingTarget()
    focusTextEntry()
    handleEditorKeydown(target, press({ key: 's', metaKey: true }))
    handleEditorKeydown(target, press({ key: 'Delete' }))
    handleEditorKeydown(target, press({ key: 'ArrowLeft' }))
    expect(target.calls).toEqual([])
  })

  it('gates commands (but not Escape) while an overlay is presented', () => {
    const target = new RecordingTarget()
    target.overlayPresented = true
    handleEditorKeydown(target, press({ key: 's', metaKey: true }))
    handleEditorKeydown(target, press({ key: 'Delete' }))
    handleEditorKeydown(target, press({ key: 'Escape' }))
    expect(target.calls).toEqual(['escape'])
  })

  it('deletes on Delete and Backspace', () => {
    const target = new RecordingTarget()
    handleEditorKeydown(target, press({ key: 'Delete' }))
    handleEditorKeydown(target, press({ key: 'Backspace' }))
    expect(target.calls).toEqual(['delete', 'delete'])
  })

  it('prevents the default only when a nudge was handled', () => {
    const handled = new RecordingTarget()
    const handledEvent = press({ key: 'ArrowLeft' })
    handleEditorKeydown(handled, handledEvent)
    expect(handled.calls).toEqual(['nudge'])
    expect(handledEvent.defaultPrevented).toBe(true)

    const unhandled = new RecordingTarget()
    unhandled.nudgeHandled = false
    const unhandledEvent = press({ key: 'ArrowLeft' })
    handleEditorKeydown(unhandled, unhandledEvent)
    expect(unhandled.calls).toEqual(['nudge'])
    expect(unhandledEvent.defaultPrevented).toBe(false)
  })
})

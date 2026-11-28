import { uploadSuccess } from './lab-validation'
import type { editor } from 'monaco-editor'
import { object, check, validLimit } from './submission-contract'
import type { LabDetail } from './types'

export type IntegrityPolicy = { version: string; block_paste: boolean; block_drop: boolean; block_large_insert: boolean; large_insert_threshold: number; flush_interval_ms: number; max_batch_items: number; max_batch_bytes: number }
export type EventType = 'lab_opened' | 'paste_blocked' | 'large_insert' | 'tab_hidden' | 'tab_visible' | 'window_blur' | 'window_focus' | 'run'
export type IntegrityEvent = { event_id: string; session_id: string; type: EventType; payload: { chars?: number | null }; ts: string }
export type Emit = (type: EventType, payload?: { chars?: number | null }) => void
export function labDetail(value: unknown): LabDetail {
  const v = object(value); const p = object(v.integrity_policy)
  check(['id', 'title', 'instructions', 'starter'].every(k => typeof v[k] === 'string') && validLimit(v.max_submissions) && typeof v.allow_resubmissions === 'boolean')
  check(typeof p.version === 'string' && ['block_paste', 'block_drop', 'block_large_insert'].every(k => typeof p[k] === 'boolean'))
  check(['large_insert_threshold', 'flush_interval_ms', 'max_batch_items', 'max_batch_bytes'].every(k => Number.isSafeInteger(p[k]) && (p[k] as number) > 0))
  if ('validated_at' in v || 'validation' in v) {
    if (v.validated_at !== null || v.validation !== null) uploadSuccess(v)
  }
  return v as LabDetail
}
export function installIntegrityGuard(instance: editor.IStandaloneCodeEditor, wrapper: HTMLElement, policy: IntegrityPolicy | null, emit: Emit, warn: (message: string) => void, onAcceptedChange: (code: string) => void) {
  const model = instance.getModel()
  if (!model) throw Error('The editor is not ready.')
  let accepted = model.getValue()
  let restoring = false
  let copiedText: string | null = null
  let internalPaste = false
  if (policy) instance.updateOptions({ contextmenu: false, dragAndDrop: !policy.block_drop, formatOnPaste: false, formatOnType: false, quickSuggestions: false, suggestOnTriggerCharacters: false, acceptSuggestionOnEnter: 'off', tabCompletion: 'off', snippetSuggestions: 'none', inlineSuggest: { enabled: false } })
  function block(event: Event, chars: number | null) {
    event.preventDefault(); event.stopImmediatePropagation()
    emit('paste_blocked', { chars: chars === null ? null : Math.min(chars, 10_000_000) })
    warn('Only text copied or cut from this lab editor can be pasted. External pastes and text drops are blocked.')
  }
  function copy(event: ClipboardEvent) {
    copiedText = null
    if (!policy?.block_paste || !event.clipboardData) return
    const selection = instance.getSelection()
    if (!selection || selection.isEmpty()) return
    const text = model!.getValueInRange(selection)
    // Own the clipboard write so the permitted value matches exactly what was copied.
    event.preventDefault(); event.stopImmediatePropagation()
    event.clipboardData.setData('text/plain', text)
    copiedText = text
    if (event.type === 'cut') {
      instance.pushUndoStop()
      instance.executeEdits('internal-cut', [{ range: selection, text: '', forceMoveMarkers: true }])
      instance.pushUndoStop()
    }
  }
  function outsideCopy(event: Event) {
    if (!(event.target instanceof Node) || !wrapper.contains(event.target)) copiedText = null
  }
  function paste(event: ClipboardEvent) {
    if (!policy?.block_paste) return
    const text = event.clipboardData?.getData('text/plain')
    const selections = instance.getSelections()
    if (!text || text !== copiedText || !selections?.length) {
      block(event, text?.length ?? null)
      return
    }
    event.preventDefault(); event.stopImmediatePropagation()
    // Only this synchronous, verified insertion bypasses the bulk-insert guard.
    internalPaste = true
    try {
      instance.pushUndoStop()
      instance.executeEdits('internal-paste', selections.map(range => ({ range, text, forceMoveMarkers: true })))
      instance.pushUndoStop()
    } finally { internalPaste = false }
  }
  function drop(event: DragEvent) { if (policy?.block_drop) block(event, event.dataTransfer?.getData('text/plain').length ?? null) }
  function dragover(event: DragEvent) { if (policy?.block_drop) event.preventDefault() }
  // Let keyboard shortcuts reach the paste event, where clipboard text is available.
  wrapper.addEventListener('copy', copy, true); wrapper.addEventListener('cut', copy, true)
  document.addEventListener('copy', outsideCopy, true); document.addEventListener('cut', outsideCopy, true)
  wrapper.addEventListener('paste', paste, true); wrapper.addEventListener('drop', drop, true)
  wrapper.addEventListener('dragover', dragover, true)
  const change = model.onDidChangeContent(event => {
    if (restoring) return
    const inserted = event.changes.reduce((sum, edit) => sum + edit.text.length, 0)
    if (policy?.block_large_insert && !internalPaste && inserted > policy.large_insert_threshold && !event.isUndoing && !event.isRedoing) {
      const position = instance.getPosition(); restoring = true
      try { model.setValue(accepted); if (position) instance.setPosition(model.validatePosition(position)) } finally { restoring = false }
      emit('large_insert', { chars: Math.min(inserted, 10_000_000) })
      warn(`Changes inserting more than ${policy.large_insert_threshold} characters at once are disabled.`)
      return
    }
    accepted = model.getValue(); onAcceptedChange(accepted)
  })
  return { getAcceptedCode: () => accepted, dispose() {
    change.dispose(); wrapper.removeEventListener('paste', paste, true); wrapper.removeEventListener('drop', drop, true)
    wrapper.removeEventListener('dragover', dragover, true)
    wrapper.removeEventListener('copy', copy, true); wrapper.removeEventListener('cut', copy, true)
    document.removeEventListener('copy', outsideCopy, true); document.removeEventListener('cut', outsideCopy, true)
    copiedText = null
  } }
}

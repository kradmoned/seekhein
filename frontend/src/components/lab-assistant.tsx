import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { deletedConversation, unresolvedQuestions, isUuid, chatHistory, chatPrefix, chatReply, conversation, conversationPage, pendingQuestions, saveQuestion, validateChat, type ChatTurn, type Conversation, type PendingChat, type ChatReply } from '@/lib/chat'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { LoadingStatus } from '@/components/loading-state'

type Props = { userId: string; labId: string; getCode: () => string; attemptId: string | null; contextLabel: string; editorReady: boolean; onClose: () => void }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Assistant request failed.'

export function LabAssistant(props: Props) {
  const { userId, labId } = props
  const [items, setItems] = useState<Conversation[]>([])
  const [selected, setSelected] = useState('')
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const selectionKey = `lab-chat-selection:${userId}:${labId}`
  const choose = useCallback((id: string) => { setSelected(id); try { localStorage.setItem(selectionKey, id) } catch { /* Pending writes are checked before sending. */ } }, [selectionKey])
  const load = useCallback(async (after = 0) => {
    lock.current = true; setBusy(true); setError('')
    controller.current?.abort(); const request = new AbortController(); controller.current = request
    try {
      let page = conversationPage(await api(`/api/labs/${labId}/conversations?after=${after}&limit=20`, { signal: request.signal }, userId), labId)
      let restored = ''; try { restored = localStorage.getItem(selectionKey) ?? '' } catch { /* Use latest. */ }
      if (!after && isUuid(restored)) {
        while (!page.conversations.some(c => c.conversation_id === restored) && page.next_after !== null) {
          const cursor = page.next_after
          const more = conversationPage(await api(`/api/labs/${labId}/conversations?after=${cursor}&limit=20`, { signal: request.signal }, userId), labId)
          if (more.next_after !== null && more.next_after <= cursor) throw Error('Invalid conversation pagination.')
          page = { conversations: [...page.conversations, ...more.conversations], next_after: more.next_after }
        }
      }
      if (request.signal.aborted) return
      setItems(old => after ? [...old, ...page.conversations.filter(c => !old.some(o => o.conversation_id === c.conversation_id))] : page.conversations)
      setNext(page.next_after); setLoaded(true)
      if (!after) {
        choose(page.conversations.find(c => c.conversation_id === restored)?.conversation_id ?? page.conversations[0]?.conversation_id ?? '')
      }
    } catch (e) { if (!request.signal.aborted) { setError(messageOf(e)); setLoaded(false) } }
    finally { if (controller.current === request) { lock.current = false; if (!request.signal.aborted) setBusy(false) } }
  }, [labId, userId, selectionKey, choose])
  // Synchronize server-owned conversations when this lab panel mounts.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); return () => controller.current?.abort() }, [load])
  async function create() {
    if (lock.current || !loaded) return
    if (Date.now() < retryAt) { setError(`Wait ${Math.ceil((retryAt - Date.now()) / 1000)} seconds before creating another conversation.`); return }
    lock.current = true; setBusy(true); setError('')
    const request = new AbortController(); controller.current = request
    try {
      const created = conversation(await api(`/api/labs/${labId}/conversations`, { method: 'POST', signal: request.signal }, userId), labId)
      if (!request.signal.aborted) { setItems(old => [created, ...old]); choose(created.conversation_id) }
    } catch (e) {
      if (!request.signal.aborted) {
        setLoaded(false)
        setError(`${messageOf(e)} Refresh conversations before creating another; the conversation may already exist.`)
        if (e instanceof ApiError && e.retryAfter) setRetryAt(Date.now() + e.retryAfter * 1000)
      }
    } finally { if (controller.current === request) { lock.current = false; if (!request.signal.aborted) setBusy(false) } }
  }
  async function removed(id: string, reset: boolean) {
    setItems(old => old.filter(c => c.conversation_id !== id)); choose('')
    if (reset) await create()
  }
  return <section aria-label="Lab assistant" className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
    <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3 py-2"><h2 className="font-medium">Lab assistant</h2><Button size="sm" variant="ghost" onClick={props.onClose}>Close assistant</Button></header>
    <div className="shrink-0 space-y-2 border-b p-3">
      <div className="flex gap-2"><select aria-label="Conversation" value={selected} disabled={busy} onChange={e => choose(e.target.value)} className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"><option value="">Choose a conversation</option>{selected && !items.some(c => c.conversation_id === selected) && <option value={selected}>Restored conversation</option>}{items.map((c, i) => <option key={c.conversation_id} value={c.conversation_id}>{new Date(c.created_at).toLocaleString()} · {i + 1}</option>)}</select><Button size="sm" variant="outline" disabled={busy || !loaded} onClick={() => void create()}>New chat</Button></div>
      <div className="flex gap-2"><Button size="xs" variant="ghost" disabled={busy} onClick={() => void load()}>Refresh conversations</Button>{next !== null && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void load(next)}>More conversations</Button>}</div>
      {busy && <LoadingStatus>Loading conversations…</LoadingStatus>}
      {error && <Notice tone="warning" title="Conversation needs attention">{error}</Notice>}
    </div>
    {selected ? <ChatThread key={selected} {...props} conversationId={selected} lifecycle={items.find(c => c.conversation_id === selected)?.lifecycle ?? 'deleting'} onDeleted={removed} onNew={() => void create()} /> : <div className="p-5 text-sm text-muted-foreground">{loaded ? 'Start a new chat to ask about this lab. Your conversations are saved for your next visit.' : 'Load your conversations to continue.'}</div>}
  </section>
}

function ChatThread({ userId, conversationId, getCode, attemptId, contextLabel, editorReady, lifecycle, onDeleted, onNew }: Props & { conversationId: string; lifecycle: Conversation['lifecycle']; onDeleted: (id: string, reset: boolean) => Promise<void>; onNew: () => void }) {
  const [policy, setPolicy] = useState<{ protocol_version: 1 | 2; can_send: boolean; blocking_turn_id: string | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'reset' | null>(null)
  const cleanupKey = `lab-chat-reset:${userId}:${conversationId}`
  const [resetRequested, setResetRequested] = useState(() => { try { return localStorage.getItem(cleanupKey) === 'true' } catch { return false } })
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [historyReady, setHistoryReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<PendingChat[]>([])
  const [storageError, setStorageError] = useState('')
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(0)
  const [reply, setReply] = useState<ChatReply | null>(null)
  const active = useRef(false)
  const sending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const historyController = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const readPending = useCallback(() => {
    try { setPending(pendingQuestions(userId, conversationId, localStorage)); setStorageError('') }
    catch (e) { setStorageError(`${messageOf(e)} New questions are paused until recovery storage is available.`) }
  }, [userId, conversationId])
  const history = useCallback(async (after = 0, all = false) => {
    historyController.current?.abort(); const request = new AbortController(); historyController.current = request
    setLoading(true)
    try {
      let latestPolicy: typeof policy = null
      let cursor = after; const collected: ChatTurn[] = []; let nextPage: number | null
      do {
        const page = chatHistory(await api(`/api/conversations/${conversationId}/messages?after=${cursor}&limit=20`, { signal: request.signal }, userId), conversationId)
        latestPolicy = page
        collected.push(...page.turns); nextPage = page.next_after
        if (nextPage !== null && nextPage <= cursor) throw Error('Invalid history pagination.')
        cursor = nextPage ?? 0
      } while (all && nextPage !== null)
      if (request.signal.aborted || !active.current) return
      setTurns(old => after ? [...old.filter(t => !collected.some(c => c.turn_id === t.turn_id)), ...collected].sort((a, b) => a.sequence - b.sequence) : collected)
      setNext(nextPage); setPolicy(latestPolicy); setHistoryReady(true)
      setReply(old => old && collected.some(t => t.turn_id === old.turn_id) ? null : old)
      return collected
    } catch (e) { if (active.current && !request.signal.aborted) { setError(messageOf(e)); setHistoryReady(false) } }
    finally { if (active.current && !request.signal.aborted) setLoading(false) }
  }, [userId, conversationId])
  useEffect(() => {
    active.current = true
    // Synchronize external recovery storage and server history on conversation changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    readPending(); void history()
    const changed = (e: StorageEvent) => { if (e.key === null || e.key.startsWith(chatPrefix(userId, conversationId))) { readPending(); void history(0, true) } }
    window.addEventListener('storage', changed)
    return () => { active.current = false; controller.current?.abort(); historyController.current?.abort(); window.removeEventListener('storage', changed) }
  }, [readPending, history, userId, conversationId])
  useEffect(() => { if (!wait) return; const timer = window.setInterval(() => setWait(n => Math.max(0, n - 1)), 1000); return () => clearInterval(timer) }, [wait])
  useEffect(() => { if (reply || busy) end.current?.scrollIntoView({ block: 'nearest' }) }, [reply, busy])
  const isDeleting = deleting || lifecycle === 'deleting'
  const legacy = policy?.protocol_version === 1
  const unresolved = unresolvedQuestions(pending, turns)
  function showError(e: unknown) {
    const code = e instanceof ApiError ? e.code : ''
    if (code === 'CONVERSATION_DELETING' || code === 'CLEANUP_PROCESSING') setDeleting(true)
    if (code === 'CONVERSATION_LEGACY') setPolicy({ protocol_version: 1, can_send: false, blocking_turn_id: null })
    const guidance: Record<string, string> = {
      TUTOR_CONTEXT_TOO_LARGE: 'The service context exceeds its limit. Ask the course administrator to review the integration.',
      TUTOR_AUTH_FAILED: 'The assistant service authentication needs administrator attention.',
      TURN_SUPERSEDED: 'This older question cannot be retried in place. Use it as a new question.',
      TURN_RECOVERY_REQUIRED: 'Recover the previous answer before continuing.',
      CONVERSATION_LEGACY: 'This chat is read-only. Start a new chat to continue.',
      CONVERSATION_DELETING: 'Deletion is unfinished. Retry delete to finish cleanup.',
      CLEANUP_PROCESSING: 'Deletion is processing. Wait before retrying delete.',
    }
    setError(`${messageOf(e)} ${guidance[code ?? ''] ?? 'Your saved request is preserved. Check the conversation state below before retrying.'}`)
    if (e instanceof ApiError) setWait(Math.ceil(Math.max(e.retryAfter ?? 0, ['TURN_PROCESSING', 'TURN_LEASE_LOST', 'CLEANUP_PROCESSING'].includes(e.code ?? '') ? 2 : e.status === 429 ? 60 : 0)))
  }
  async function send(saved: PendingChat | null, turnId?: string) {
    if (sending.current || wait || isDeleting || legacy) return
    sending.current = true; setBusy(true); setError(''); setReply(null)
    const request = new AbortController(); controller.current = request
    try {
      const response = chatReply(await api(turnId ? `/api/conversations/${conversationId}/turns/${turnId}/recover` : `/api/conversations/${conversationId}/messages`, turnId ? { method: 'POST', signal: request.signal } : { method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': saved!.key }, body: JSON.stringify(saved!.input) }, userId), conversationId)
      if (turnId && response.turn_id !== turnId) throw Error('Recovery returned a different turn. Original recovery data was preserved.')
      if (!active.current || request.signal.aborted) return
      setReply(response)
      try {
        const key = saved?.key ?? turns.find(t => t.turn_id === turnId)?.idempotency_key
        if (key) localStorage.removeItem(chatPrefix(userId, conversationId) + key)
        readPending()
      }
      catch { setStorageError('Answer saved, but local recovery data could not be removed. Replaying the question is safe.') }
      const refreshed = await history(0, true)
      // Recovery can target a blocker outside the previously loaded page. Resolve only
      // the matching browser record after the recovery reply has been validated.
      if (!saved && active.current && !request.signal.aborted) {
        const key = refreshed?.find(t => t.turn_id === response.turn_id)?.idempotency_key
        if (key) {
          try { localStorage.removeItem(chatPrefix(userId, conversationId) + key); readPending() }
          catch { setStorageError('Answer recovered, but its local recovery record could not be removed. Replaying it is safe.') }
        }
      }
    } catch (e) {
      if (active.current && !request.signal.aborted) {
        showError(e)
        await history(0, true)
      }
    } finally { sending.current = false; if (active.current) setBusy(false) }
  }
  function ask() {
    if (sending.current || wait || unresolved.length || storageError || !historyReady || !editorReady || !policy?.can_send || policy.blocking_turn_id || isDeleting || legacy) return
    // Capture editor and context exactly once. Storage must succeed before any POST.
    const input = { message: question, current_code: getCode(), attempt_id: attemptId }
    const invalid = validateChat(input); if (invalid) { setError(invalid); return }
    let saved: PendingChat
    try {
      const existing = pendingQuestions(userId, conversationId, localStorage)
      if (unresolvedQuestions(existing, turns).length) { setPending(existing); return }
      saved = saveQuestion(userId, conversationId, input, localStorage); setPending([...existing, saved])
    } catch (e) { setStorageError(`Cannot preserve this question for recovery: ${messageOf(e)} Nothing was sent.`); return }
    setQuestion(''); void send(saved)
  }
  async function cleanup(reset: boolean) {
    if (sending.current || wait || policy?.blocking_turn_id) return
    sending.current = true; setBusy(true); setError(''); setConfirm(null)
    const request = new AbortController(); controller.current = request
    try {
      // Preserve reset intent before dispatch; an interrupted DELETE remains retryable.
      if (reset) { localStorage.setItem(cleanupKey, 'true'); setResetRequested(true) }
      setDeleting(true)
      deletedConversation(await api(`/api/conversations/${conversationId}`, { method: 'DELETE', signal: request.signal }, userId), conversationId)
      if (!active.current || request.signal.aborted) return
      try {
        for (const p of pendingQuestions(userId, conversationId, localStorage)) localStorage.removeItem(chatPrefix(userId, conversationId) + p.key)
        localStorage.removeItem(cleanupKey)
      } catch { /* Remote deletion is confirmed. Stale local records cannot revive this ID. */ }
      await onDeleted(conversationId, reset)
    } catch (e) {
      if (active.current && !request.signal.aborted) {
        if (e instanceof ApiError && e.code === 'TURN_RECOVERY_REQUIRED') setDeleting(false)
        showError(e)
        await history(0, true)
      }
    } finally { sending.current = false; if (active.current) setBusy(false) }
  }
  return <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" aria-label="Conversation messages" tabIndex={0}>
      <Button size="xs" variant="ghost" disabled={loading} onClick={() => { setError(''); readPending(); void history(0, true) }}>Refresh messages</Button>
      {legacy && <Notice tone="info" title="Read-only conversation" actions={<Button size="sm" variant="outline" onClick={onNew}>Start new chat</Button>}>This conversation uses the previous assistant version. Its messages remain available.</Notice>}
      {policy?.blocking_turn_id && !legacy && !isDeleting && <Notice tone="warning" title="Previous answer needs recovery" actions={<Button size="sm" variant="outline" disabled={busy || wait > 0} onClick={() => void send(null, policy.blocking_turn_id!)}>{wait ? `Retry in ${wait}s` : 'Recover previous answer'}</Button>}>Recover the saved turn before sending another question or deleting this chat. Your current editor will not replace its saved code.</Notice>}
      {isDeleting ? <Notice tone="warning" title="Deletion unfinished" actions={<Button size="sm" variant="outline" disabled={busy || wait > 0 || !!policy?.blocking_turn_id} onClick={() => void cleanup(resetRequested)}>{wait ? `Retry in ${wait}s` : 'Retry delete'}</Button>}>Messaging is paused until cleanup succeeds.{resetRequested && ' A new chat will be created after deletion.'}</Notice> : <div className="flex gap-2"><Button size="xs" variant="ghost" disabled={busy || !historyReady || !!policy?.blocking_turn_id} onClick={() => setConfirm('delete')}>Delete chat</Button><Button size="xs" variant="ghost" disabled={busy || !historyReady || !!policy?.blocking_turn_id} onClick={() => setConfirm('reset')}>Reset chat</Button></div>}
      {confirm && <Notice tone="warning" title={confirm === 'reset' ? 'Reset this conversation?' : 'Delete this conversation?'} actions={<><Button size="sm" variant="destructive" onClick={() => void cleanup(confirm === 'reset')}>Confirm {confirm}</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></>}>This removes chat messages and the AI session. Lab runs and submissions remain saved.</Notice>}
      {loading && <LoadingStatus>Loading messages…</LoadingStatus>}
      {!turns.length && historyReady && <p className="text-sm text-muted-foreground">Ask about a confusing result or your next step. The assistant can make mistakes; check its suggestions against your code.</p>}
      {turns.map(turn => <article key={turn.turn_id} className="space-y-3" aria-label={`Turn ${turn.sequence}`}>
        {turn.messages.map(message => <div key={message.id} className={message.role === 'user' ? 'rounded-lg bg-muted p-3' : 'px-1 py-2'}><p className="mb-1 text-xs font-medium text-muted-foreground">{message.role === 'user' ? 'You' : 'Assistant'}</p><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.content}</p>{message.sources.length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary>Learning references</summary><pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(message.sources, null, 2)}</pre></details>}</div>)}
        {turn.status !== 'completed' && <p className="text-xs text-muted-foreground">{turn.status === 'recovery_required' ? 'This answer needs recovery using its saved server snapshot.' : turn.status === 'processing' ? 'Reply processing. Refresh messages to check progress.' : `Reply incomplete${turn.error_code ? ` (${turn.error_code})` : ''}. Recover the saved question if available.`}</p>}
      </article>)}
      {next !== null && <Button size="sm" variant="outline" disabled={loading} onClick={() => void history(next)}>Load more messages</Button>}
      {reply && <div role="status" className="space-y-2 rounded-lg border p-3"><p className="text-xs text-muted-foreground">Saved reply — refresh messages to view it in conversation order.</p><p className="whitespace-pre-wrap break-words text-sm">{reply.answer}</p></div>}
      {busy && <LoadingStatus>Thinking about your question…</LoadingStatus>}
      {error && <Notice tone="warning" title="Assistant needs attention">{error}</Notice>}
      {storageError && <Notice tone="error" title="Recovery storage unavailable" actions={<Button size="sm" variant="outline" onClick={readPending}>Check storage</Button>}>{storageError}</Notice>}
      {pending.map(p => <div key={p.key} className="space-y-2 rounded-lg border p-3"><p className="text-xs font-medium">Pending question</p><p className="whitespace-pre-wrap break-words text-sm">{p.input.message}</p><Button size="sm" variant="outline" disabled={busy || wait > 0 || isDeleting || !!legacy || turns.some(t => t.idempotency_key === p.key && t.status === 'failed' && turns.some(newer => newer.sequence > t.sequence)) || (!!policy?.blocking_turn_id && !turns.some(t => t.turn_id === policy.blocking_turn_id && t.idempotency_key === p.key))} onClick={() => void send(p)}>{wait ? `Retry in ${wait}s` : 'Recover question'}</Button>{turns.some(t => t.idempotency_key === p.key && t.status === 'failed') && <><p className="text-xs text-muted-foreground">This turn failed definitively. You may ask a new question; a newer turn can prevent retrying this one.</p><Button size="sm" variant="ghost" disabled={busy || isDeleting || !!legacy || !policy?.can_send} onClick={() => setQuestion(p.input.message)}>Use as new question</Button></>}<p className="text-xs text-muted-foreground">Recovery uses the original question and code. A new question captures the current editor when sent.</p></div>)}
      <div ref={end} />
    </div>
    <form className="shrink-0 space-y-2 border-t p-3" onSubmit={e => { e.preventDefault(); ask() }}>
      <p className="text-xs text-muted-foreground">{contextLabel} Current editor code is included when you send.</p>
      <label className="sr-only" htmlFor={`question-${conversationId}`}>Question for assistant</label>
      <textarea id={`question-${conversationId}`} value={question} onChange={e => setQuestion(e.target.value)} rows={3} placeholder="What would you like help understanding?" className="block max-h-40 min-h-20 w-full resize-y rounded-lg border p-2 text-sm" />
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{wait ? `Please wait ${wait}s before sending.` : !policy?.can_send ? 'Sending is currently unavailable.' : 'Only you can view this conversation.'}</span><Button size="sm" type="submit" disabled={busy || wait > 0 || !!unresolved.length || !!storageError || !historyReady || !editorReady || !policy?.can_send || !!policy?.blocking_turn_id || isDeleting || !!legacy || !question.trim()}>Send question</Button></div>
    </form>
  </>
}

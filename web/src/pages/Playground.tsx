import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, streamChat } from '../api'

interface ChatMsg {
  role: 'user' | 'bot'
  text: string
  citations?: Array<{ sourceId: string; name: string }>
  messageId?: string
  feedback?: 'up' | 'down'
}

export default function Playground() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const rate = async (index: number, feedback: 'up' | 'down') => {
    const target = messages[index]
    if (!target.messageId || !sessionId) return
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, feedback } : msg)))
    try {
      await api('POST', '/v1/assistant/feedback', { sessionId, messageId: target.messageId, feedback })
    } catch {
      setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, feedback: undefined } : msg)))
    }
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: message }])
    setBusy(true)
    try {
      // Stream first so the answer starts appearing immediately; fall back to
      // the single-response route if streaming is unavailable.
      let streamed = false
      try {
        const meta = await streamChat({ sessionId, message }, (delta) => {
          setMessages((m) => {
            if (!streamed) {
              streamed = true
              return [...m, { role: 'bot', text: delta }]
            }
            const copy = [...m]
            const last = copy[copy.length - 1]
            copy[copy.length - 1] = { ...last, text: last.text + delta }
            return copy
          })
        })
        setSessionId(meta.sessionId)
        if (streamed) {
          setMessages((m) => {
            const copy = [...m]
            const last = copy[copy.length - 1]
            copy[copy.length - 1] = { ...last, citations: meta.citations, messageId: meta.messageId }
            return copy
          })
          return
        }
      } catch {
        if (streamed) return // partial answer is on screen; don't duplicate it
      }

      const r = await api('POST', '/v1/assistant/chat', { sessionId, message })
      setSessionId(r.sessionId)
      setMessages((m) => [...m, { role: 'bot', text: r.answer, citations: r.citations, messageId: r.messageId }])
    } catch (err) {
      const code = err instanceof Error ? err.message : 'error'
      setMessages((m) => [...m, {
        role: 'bot',
        text: code === 'limit_exceeded'
          ? 'Monthly message limit reached for this plan.'
          : 'Something went wrong — try again.',
      }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Playground</h1>
      <p>Test your assistant exactly as your customers will experience it. Answers come only from your knowledge sources.</p>
      <div className="card chat">
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && <p className="hint">Ask something answerable from your documents…</p>}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
              {m.citations && m.citations.length > 0 && (
                <div className="cites">Sources: {m.citations.map((c) => c.name).join(', ')}</div>
              )}
              {m.role === 'bot' && m.messageId && (
                <div className="cites">
                  {m.feedback ? (
                    <span>Thanks — recorded {m.feedback === 'up' ? '👍' : '👎'}</span>
                  ) : (
                    <>
                      Was this helpful?{' '}
                      <a href="#" onClick={(e) => { e.preventDefault(); void rate(i, 'up') }}>👍</a>{' '}
                      <a href="#" onClick={(e) => { e.preventDefault(); void rate(i, 'down') }}>👎</a>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div className="msg bot">Thinking…</div>
          )}
        </div>
        <form className="chat-input" onSubmit={send}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a question…" autoFocus />
          <button disabled={busy || !input.trim()}>Send</button>
        </form>
      </div>
    </>
  )
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, explain, streamChat } from '../api'

interface ChatMsg {
  role: 'user' | 'bot'
  text: string
  citations?: Array<{ sourceId: string; name: string }>
  messageId?: string
  feedback?: 'up' | 'down'
  failed?: boolean
}

const STARTERS = [
  'What are your opening hours?',
  'How much does it cost?',
  'Where are you located?',
]

export default function Playground() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // null while we are still finding out whether this workspace has knowledge.
  const [hasKnowledge, setHasKnowledge] = useState<boolean | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api('GET', '/v1/assistant/sources')
      .then((r) => setHasKnowledge((r.sources ?? []).length > 0))
      .catch(() => setHasKnowledge(true)) // never block the screen on this check
  }, [])

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

  const ask = async (message: string) => {
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
        if (streamed) return // partial answer is on screen; do not duplicate it
      }

      const r = await api('POST', '/v1/assistant/chat', { sessionId, message })
      setSessionId(r.sessionId)
      setMessages((m) => [...m, { role: 'bot', text: r.answer, citations: r.citations, messageId: r.messageId }])
    } catch (err) {
      setMessages((m) => [...m, { role: 'bot', text: explain(err), failed: true }])
    } finally {
      setBusy(false)
    }
  }

  const send = (e: FormEvent) => {
    e.preventDefault()
    void ask(input.trim())
  }

  return (
    <>
      <h1>Playground</h1>
      <p>Test your assistant exactly as a customer will experience it. Answers come only from your knowledge sources.</p>

      {hasKnowledge === false && (
        <div className="card tint-warn notice">
          <span className="grow">
            <strong>No knowledge yet.</strong> Your assistant will decline every question until you give it
            something to read.
          </span>
          <Link className="btn" to="/assistant/knowledge">Add knowledge</Link>
        </div>
      )}

      <div className="card chat">
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="starters">
              <p className="hint">Try one of these, or ask anything answerable from your sources.</p>
              <div className="row">
                {STARTERS.map((s) => (
                  <button key={s} className="ghost" onClick={() => void ask(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.failed ? ' failed' : ''}`}>
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
                      <button className="linkish" onClick={() => void rate(i, 'up')} aria-label="Helpful">👍</button>{' '}
                      <button className="linkish" onClick={() => void rate(i, 'down')} aria-label="Not helpful">👎</button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div className="msg bot typing" aria-live="polite">
              <span /><span /><span />
            </div>
          )}
        </div>
        <form className="chat-input" onSubmit={send}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a question…"
            autoFocus aria-label="Your question" />
          <button disabled={busy || !input.trim()}>Send</button>
        </form>
      </div>

      {messages.length > 0 && (
        <p className="meta">
          Got an answer that was wrong or missing? Add the right information under{' '}
          <Link to="/assistant/knowledge">Knowledge</Link> and ask again.
        </p>
      )}
    </>
  )
}

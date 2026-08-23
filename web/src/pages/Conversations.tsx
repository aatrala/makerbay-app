import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api'

interface SessionRow {
  sessionId: string
  firstQuestion: string
  lastAt: string
  messageCount: number
  unansweredCount: number
  thumbsDownCount: number
  thumbsUpCount: number
}

interface Message {
  sk: string
  role: 'user' | 'assistant'
  text: string
  citations?: Array<{ name: string }>
  fallback?: boolean
  feedback?: 'up' | 'down'
}

export default function Conversations() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [filter, setFilter] = useState<'all' | 'attention'>('attention')
  const [openId, setOpenId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [teach, setTeach] = useState<{ question: string; answer: string } | null>(null)
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api('GET', `/v1/assistant/conversations${filter === 'attention' ? '?filter=attention' : ''}`)
    setSessions(r.sessions ?? [])
    setLoading(false)
  }, [filter])

  useEffect(() => { void load() }, [load])

  const open = async (sessionId: string) => {
    if (openId === sessionId) { setOpenId(null); return }
    setOpenId(sessionId)
    const r = await api('GET', `/v1/assistant/conversations?sessionId=${encodeURIComponent(sessionId)}`)
    setMessages(r.messages ?? [])
  }

  // Turn a question the bot couldn't answer into knowledge it will use next time.
  const startTeaching = (question: string) => { setTeach({ question, answer: '' }); setSaved('') }

  const saveAnswer = async () => {
    if (!teach || !teach.answer.trim()) return
    await api('POST', '/v1/assistant/sources', {
      type: 'text',
      name: `Q&A: ${teach.question.slice(0, 60)}`,
      text: `Question: ${teach.question}\n\nAnswer: ${teach.answer.trim()}`,
    })
    setSaved('Added to knowledge — it will be used once processing finishes.')
    setTeach(null)
  }

  return (
    <>
      <h1>Conversations</h1>
      <p>Every question your customers asked. Start with the ones that need attention — each is a chance to make the assistant better.</p>

      <div className="tabs">
        <button className={filter === 'attention' ? 'on' : ''} onClick={() => setFilter('attention')}>Needs attention</button>
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All conversations</button>
      </div>

      {saved && <div className="card" style={{ background: '#f0fdf7', borderColor: '#b5e5cf' }}>{saved}</div>}

      {teach && (
        <div className="card">
          <h2>Teach your assistant</h2>
          <p><strong>Question:</strong> {teach.question}</p>
          <label>Your answer</label>
          <textarea rows={4} autoFocus value={teach.answer}
            onChange={(e) => setTeach({ ...teach, answer: e.target.value })}
            placeholder="Write the answer you'd want a customer to receive…" />
          <div className="mt row">
            <button onClick={() => void saveAnswer()} disabled={!teach.answer.trim()}>Add to knowledge</button>
            <button className="ghost" onClick={() => setTeach(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <p>Loading…</p> : sessions.length === 0 ? (
          <p>{filter === 'attention'
            ? 'Nothing needs attention — every question was answered from your knowledge.'
            : 'No conversations yet. Share your assistant from the Deploy screen.'}</p>
        ) : (
          <table>
            <thead><tr><th>First question</th><th>Messages</th><th>Signals</th><th>Last activity</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <Fragment key={s.sessionId}>
                  <tr onClick={() => void open(s.sessionId)} style={{ cursor: 'pointer' }}>
                    <td>{s.firstQuestion || <span className="hint">(no question)</span>}</td>
                    <td>{s.messageCount}</td>
                    <td>
                      {s.unansweredCount > 0 && <span className="chip failed">{s.unansweredCount} unanswered</span>}{' '}
                      {s.thumbsDownCount > 0 && <span className="chip processing">{s.thumbsDownCount} 👎</span>}{' '}
                      {s.thumbsUpCount > 0 && <span className="chip ready">{s.thumbsUpCount} 👍</span>}
                    </td>
                    <td>{new Date(s.lastAt).toLocaleString()}</td>
                  </tr>
                  {openId === s.sessionId && (
                    <tr>
                      <td colSpan={4} style={{ background: '#fafbfd' }}>
                        {messages.map((m, i) => (
                          <div key={m.sk} style={{ marginBottom: 10 }}>
                            <div className={`msg ${m.role === 'user' ? 'user' : 'bot'}`} style={{ maxWidth: '100%' }}>
                              {m.text}
                              {m.citations && m.citations.length > 0 && (
                                <div className="cites">Sources: {m.citations.map((c) => c.name).join(', ')}</div>
                              )}
                            </div>
                            {m.role === 'assistant' && (m.fallback || m.feedback === 'down') && (
                              <button className="ghost" style={{ marginTop: 6 }}
                                onClick={() => startTeaching(messages[i - 1]?.text ?? s.firstQuestion)}>
                                Add answer to knowledge
                              </button>
                            )}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

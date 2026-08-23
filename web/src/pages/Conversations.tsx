import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, explain } from '../api'
import { Empty, Notice, Skeleton, when } from '../ui'

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
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api('GET', `/v1/assistant/conversations${filter === 'attention' ? '?filter=attention' : ''}`)
      setSessions(r.sessions ?? [])
    } catch (e) {
      setError(explain(e))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { void load() }, [load])

  const open = async (sessionId: string) => {
    if (openId === sessionId) { setOpenId(null); return }
    setOpenId(sessionId)
    setMessages([])
    const r = await api('GET', `/v1/assistant/conversations?sessionId=${encodeURIComponent(sessionId)}`)
    setMessages(r.messages ?? [])
  }

  // Turn a question the bot could not answer into knowledge it will use next time.
  const startTeaching = (question: string) => { setTeach({ question, answer: '' }); setSaved(''); setError('') }

  const saveAnswer = async () => {
    if (!teach || !teach.answer.trim()) return
    try {
      await api('POST', '/v1/assistant/sources', {
        type: 'text',
        name: `Q&A: ${teach.question.slice(0, 60)}`,
        text: `Question: ${teach.question}\n\nAnswer: ${teach.answer.trim()}`,
      })
      setSaved('Added to knowledge. Your assistant will use it once processing finishes, usually a minute or two.')
      setTeach(null)
    } catch (e) {
      setError(explain(e))
    }
  }

  return (
    <>
      <h1>Conversations</h1>
      <p>Every question your customers asked. Start with the ones that need attention — each is a chance to make the assistant better.</p>

      <div className="tabs">
        <button className={filter === 'attention' ? 'on' : ''} onClick={() => setFilter('attention')}>Needs attention</button>
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All conversations</button>
      </div>

      {saved && <Notice tone="ok" onClose={() => setSaved('')}>{saved}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {teach && (
        <div className="card">
          <h2>Teach your assistant</h2>
          <p className="quoted">{teach.question}</p>
          <label htmlFor="answer">Your answer</label>
          <textarea id="answer" rows={4} autoFocus value={teach.answer}
            onChange={(e) => setTeach({ ...teach, answer: e.target.value })}
            placeholder="Write the answer you would want a customer to receive…" />
          <div className="mt row">
            <button onClick={() => void saveAnswer()} disabled={!teach.answer.trim()}>Add to knowledge</button>
            <button className="ghost" onClick={() => setTeach(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <Skeleton rows={5} /> : sessions.length === 0 ? (
          filter === 'attention' ? (
            <Empty title="Nothing needs attention"
              action={<button className="ghost" onClick={() => setFilter('all')}>See all conversations</button>}>
              Every question was answered from your knowledge. Come back after your assistant has been
              busy for a while.
            </Empty>
          ) : (
            <Empty title="No conversations yet"
              action={<Link className="btn" to="/assistant/deploy">Put it on your website</Link>}>
              Once your assistant is live on your site or shared as a link, every question customers
              ask will appear here.
            </Empty>
          )
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>First question</th><th>Messages</th><th>Signals</th><th>Last activity</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <Fragment key={s.sessionId}>
                    <tr onClick={() => void open(s.sessionId)} className="clickable"
                      aria-expanded={openId === s.sessionId}>
                      <td>{s.firstQuestion || <span className="meta">(no question)</span>}</td>
                      <td>{s.messageCount}</td>
                      <td className="nowrap">
                        {s.unansweredCount > 0 && <span className="chip failed">{s.unansweredCount} unanswered</span>}{' '}
                        {s.thumbsDownCount > 0 && <span className="chip processing">{s.thumbsDownCount} 👎</span>}{' '}
                        {s.thumbsUpCount > 0 && <span className="chip ready">{s.thumbsUpCount} 👍</span>}
                      </td>
                      <td className="nowrap">{when(s.lastAt)}</td>
                    </tr>
                    {openId === s.sessionId && (
                      <tr className="expanded">
                        <td colSpan={4}>
                          {messages.length === 0 ? <Skeleton rows={2} /> : messages.map((m, i) => (
                            <div key={m.sk} className="transcript-turn">
                              <div className={`msg ${m.role === 'user' ? 'user' : 'bot'}`}>
                                {m.text}
                                {m.citations && m.citations.length > 0 && (
                                  <div className="cites">Sources: {m.citations.map((c) => c.name).join(', ')}</div>
                                )}
                              </div>
                              {m.role === 'assistant' && (m.fallback || m.feedback === 'down') && (
                                <button className="ghost mt-sm"
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
          </div>
        )}
      </div>
    </>
  )
}

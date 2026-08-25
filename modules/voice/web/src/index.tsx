import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Route } from 'react-router-dom'
import {
  Empty,
  Notice,
  Skeleton,
  api,
  explain,
  when,
  type DashboardModule,
} from '@makerbay/web-kit'

interface RescueConfig {
  phoneNumber?: string
  greetingText: string
  notifyEmail: string
}

interface Forwarding {
  number: string
  enableOnNoAnswer: string
  enableWhenBusy: string
  disable: string
  note: string
}

interface Rescue {
  rescueId: string
  caller: string
  status: string
  at: string
  smsSent?: boolean
  smsError?: string
  transcript?: string
  requestId?: string
  extracted?: { job?: string; name?: string; urgent?: boolean }
}

function RescuePage() {
  const [config, setConfig] = useState<RescueConfig | null>(null)
  const [forwarding, setForwarding] = useState<Forwarding | null>(null)
  const [rescues, setRescues] = useState<Rescue[] | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/voice/config')
      setConfig(r.config)
      setForwarding(r.forwarding)
      setRescues((await api('GET', '/v1/voice/rescues')).rescues)
    } catch (e) {
      setError(explain(e))
      setRescues([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    void (async () => {
      setError(''); setNote(''); setBusy(true)
      try {
        const r = await api('PUT', '/v1/voice/config', config)
        setConfig(r.config)
        setForwarding(r.forwarding)
        setNote('Saved. The greeting callers hear has been re-recorded with your words.')
      } catch (err) {
        setError(explain(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <>
      <h1>Missed-call rescue</h1>
      <p>
        When you cannot answer, the caller hears a short greeting in your name, gets a text with
        your booking link while they are still holding the phone, and can leave a message. The
        message is written out and lands in your <Link to="/requests">Requests</Link> inbox with
        the job details pulled out.
      </p>

      <Notice tone="warn">
        <span>
          <strong>Deliberately not a talking robot.</strong> We looked hard at AI receptionists
          that hold a conversation: every one on the market answers over a second late, roughly a
          third of callers say they would hang up on one, and when it misquotes a price the caller
          blames <em>you</em>. A fast text and an accurate transcript do most of the job with none
          of that risk.
        </span>
      </Notice>

      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}

      {!config ? <div className="card"><Skeleton rows={5} /></div> : (
        <>
          <div className="card">
            <h2>Your rescue number</h2>
            {config.phoneNumber && forwarding ? (
              <>
                <p className="stat">{config.phoneNumber}</p>
                <p className="hint">
                  Unanswered calls forward here. Set it up once by dialling this from your own
                  phone:
                </p>
                <dl className="facts">
                  <dt>Forward when unanswered</dt><dd><code>{forwarding.enableOnNoAnswer}</code></dd>
                  <dt>Forward when busy</dt><dd><code>{forwarding.enableWhenBusy}</code></dd>
                  <dt>Turn all forwarding off</dt><dd><code>{forwarding.disable}</code></dd>
                </dl>
                <p className="meta">{forwarding.note}</p>
              </>
            ) : (
              <p className="meta">
                No number is assigned to this workspace yet. Numbers are being issued during the
                pilot (US numbers first - Australian and Indian numbers have carrier requirements
                we are still working through). Everything below is ready for when yours arrives.
              </p>
            )}
          </div>

          <div className="card">
            <form onSubmit={save}>
              <label htmlFor="r-greet">What callers hear</label>
              <textarea id="r-greet" rows={3} value={config.greetingText}
                onChange={(e) => setConfig({ ...config, greetingText: e.target.value })} />
              <p className="meta">
                Read by a natural voice, re-recorded whenever you save. Keep it short - the text
                with your booking link arrives while they listen.
              </p>
              <label htmlFor="r-notify">Email me about missed calls at</label>
              <input id="r-notify" type="email" value={config.notifyEmail}
                placeholder="you@yourbusiness.com.au"
                onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} />
              <p className="meta">
                An email per rescued call: who rang, what the text said, and whether they booked.
                The caller gets an SMS; this address is for you.
              </p>
              <div className="mt"><button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
            </form>
          </div>

          <div className="card">
            <h2>Rescued calls</h2>
            {!rescues ? <Skeleton rows={3} /> : rescues.length === 0 ? (
              <Empty title="No missed calls yet">
                Once forwarding is on, every call you cannot take appears here with what happened
                next - texted, voicemail, and whether it turned into a booking.
              </Empty>
            ) : (
              <div className="scroll-x">
                <table>
                  <thead>
                    <tr><th>Caller</th><th>What happened</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {rescues.map((r) => (
                      <tr key={r.rescueId}>
                        <td className="nowrap">{r.caller || 'Withheld'}</td>
                        <td>
                          {r.smsSent ? <span className="chip ready">texted</span> : <span className="chip awaiting_upload">no text</span>}{' '}
                          {r.transcript ? <span className="chip ready">voicemail</span> : null}{' '}
                          {r.extracted?.urgent ? <span className="chip failed">urgent</span> : null}
                          {r.extracted?.job && <div className="meta trunc">{r.extracted.job}</div>}
                          {r.requestId && (
                            <div className="meta"><Link to={`/requests/${r.requestId}`}>open the lead</Link></div>
                          )}
                        </td>
                        <td className="nowrap">{when(r.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="meta mt">
              Every rescued call is tracked through to whether it became a booking - the number
              this whole category never publishes.
            </p>
          </div>
        </>
      )}
    </>
  )
}

export const voiceDashboard: DashboardModule = {
  id: 'voice',
  label: 'Missed calls',
  nav: [{ to: '/rescue', label: 'Rescue' }],
  routes: () => (
    <>
      <Route path="/rescue" element={<RescuePage />} />
    </>
  ),
}

export default voiceDashboard

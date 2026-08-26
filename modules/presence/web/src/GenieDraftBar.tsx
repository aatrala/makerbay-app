import { useState } from 'react'
import { api, explain } from '@makerbay/web-kit'

export interface CopyDraft {
  headline?: string
  intro?: string
  faq?: Array<{ q: string; a: string }>
}

/**
 * "Draft with Genie" (issue 75). The endpoint writes nothing: the draft
 * lands as unsaved form state, renders on the live preview within a second,
 * and the owner's read-and-save IS the confirmation. Each draft costs one
 * Genie message from the same allowance as chat.
 */
export default function GenieDraftBar({ fields, onApply, label }: {
  fields: Array<'headline' | 'intro' | 'faq'>
  onApply: (draft: CopyDraft) => void
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [instruction, setInstruction] = useState('')

  const draft = async () => {
    setBusy(true); setError(''); setNote('')
    try {
      const r = await api('POST', '/v1/presence/copy-draft', {
        fields,
        instruction: instruction.trim() || undefined,
      })
      onApply(r.draft ?? {})
      const f = r.factsUsed ?? {}
      setNote(
        `Drafted from ${f.services ?? 0} service${f.services === 1 ? '' : 's'}, ` +
        `${f.reviews ?? 0} review${f.reviews === 1 ? '' : 's'} and your documents. ` +
        'Unsaved until you press Save — edit anything that does not sound like you.',
      )
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="ghost" disabled={busy} onClick={() => void draft()}>
        {busy ? 'Genie is writing…' : label ?? '✨ Draft with Genie'}
      </button>
      <input
        className="grow"
        value={instruction}
        maxLength={200}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Optional: e.g. mention we do emergency call-outs"
        aria-label="Instruction for Genie"
      />
      {note && <p className="meta" style={{ width: '100%', margin: 0 }}>{note}</p>}
      {error && <p className="meta warn-text" style={{ width: '100%', margin: 0 }}>{error}</p>}
    </div>
  )
}

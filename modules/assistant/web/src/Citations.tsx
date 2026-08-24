import { useState } from 'react'

export interface Citation {
  sourceId: string
  name: string
  excerpt?: string
  sourceUrl?: string
}

/**
 * "Where did this come from" should be answerable without leaving the answer.
 * Collapsed by default: the passage matters when someone doubts the answer,
 * not on every reply.
 */
export default function Citations({ citations }: { citations?: Citation[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!citations?.length) return null

  return (
    <div className="cites">
      <span className="cites-label">Based on</span>
      {citations.map((c) => (
        <span key={c.sourceId || c.name}>
          {' '}
          <button className="linkish" aria-expanded={open === c.sourceId}
            onClick={() => setOpen(open === c.sourceId ? null : c.sourceId)}>
            {c.name}
          </button>
          {open === c.sourceId && (
            <span className="cite-passage">
              {c.excerpt ? <q>{c.excerpt}</q> : <em>No passage recorded for this answer.</em>}
              {c.sourceUrl && (
                <>
                  {' '}
                  <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">Open the page</a>
                </>
              )}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

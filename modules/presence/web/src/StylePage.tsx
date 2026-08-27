import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Notice, Skeleton, api, explain, when } from '@makerbay/web-kit'
import GenieDraftBar from './GenieDraftBar'

/**
 * The Page style screen (issue 45, docs/spec-page-styles.md). Every option
 * is visible to every tier - locked ones carry their tier chip and the
 * server refuses anything above the caller's plan. The ladder: Free looks
 * good, Trade is arranged your way, Genie is fully branded.
 */

type BlockId = 'about' | 'services' | 'faq' | 'reviews' | 'hours' | 'contact'
interface PageSettings {
  pageStyle: 'simple' | 'grow' | 'storefront'
  blocks: Array<{ id: BlockId; visible: boolean }>
  faq: Array<{ q: string; a: string }>
  palette?: { paper?: string; ink?: string; button?: string }
  fontPair?: string
}
type Tier = 'free' | 'pro' | 'genie'

const BLOCK_LABEL: Record<BlockId, string> = {
  about: 'About', services: 'Services & prices', faq: 'FAQ',
  reviews: 'Reviews', hours: 'Opening hours', contact: 'Contact',
}

const STYLES: Array<{ id: PageSettings['pageStyle']; name: string; blurb: string; tier: 'free' | 'pro' }> = [
  { id: 'simple', name: 'Simple', blurb: 'Everything on one clean page. Best for getting started.', tier: 'free' },
  { id: 'grow', name: 'Grow', blurb: 'One page that grows: FAQ, services and reviews expand into their own pages as you add more.', tier: 'pro' },
  { id: 'storefront', name: 'Storefront', blurb: 'A small site: Home, Services, FAQ and Reviews as separate pages, each findable on Google.', tier: 'pro' },
]

const FONTS: Array<{ id: string; name: string }> = [
  { id: 'system', name: 'System (default)' },
  { id: 'classic', name: 'Classic — Playfair & Lora' },
  { id: 'modern', name: 'Modern — Inter' },
  { id: 'editorial', name: 'Editorial — Fraunces & Source Sans' },
  { id: 'friendly', name: 'Friendly — Nunito' },
]

/**
 * The Appearance sections, embeddable in the merged Page screen (issue 60):
 * layout, blocks, FAQ, colours, fonts, versions. Owns its own state; tells
 * the parent when a save landed so the shared preview refreshes.
 */
export function StyleSections({ onSaved }: { onSaved?: () => void }) {
  const [page, setPage] = useState<PageSettings | null>(null)
  const [tier, setTier] = useState<Tier>('free')
  const [versions, setVersions] = useState<Array<{ sk: string; at: string; label: string; style: string }> | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api('GET', '/v1/presence/page')
      setPage(r.page)
      setTier(r.tier ?? 'free')
      if (r.tier !== 'free') {
        void api('GET', '/v1/presence/versions').then((v) => setVersions(v.versions ?? [])).catch(() => {})
      }
    } catch (e) { setError(explain(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = (partial: Partial<PageSettings>) => {
    if (!page) return
    setBusy(true); setError(''); setNote('')
    void api('PUT', '/v1/presence/page', partial)
      .then((r) => {
        setPage(r.page)
        if (onSaved) onSaved()
        setNote('Saved - the preview shows it now. Visitors see it within about 5 minutes.')
        void api('GET', '/v1/presence/versions').then((v) => setVersions(v.versions ?? [])).catch(() => {})
      })
      .catch((e) => setError(explain(e)))
      .finally(() => setBusy(false))
  }

  if (!page) return (
    <>
      {error && <Notice tone="err">{error}</Notice>}
      <div className="card"><Skeleton rows={6} /></div>
    </>
  )

  const locked = (need: 'pro' | 'genie') =>
    need === 'pro' ? tier === 'free' : tier !== 'genie'

  const move = (from: number, to: number) => {
    if (to < 0 || to >= page.blocks.length) return
    const blocks = [...page.blocks]
    const [b] = blocks.splice(from, 1)
    blocks.splice(to, 0, b)
    save({ blocks })
  }

  const chip = (need: 'pro' | 'genie') => (
    <span className={`chip ${need === 'pro' ? 'processing' : 'awaiting_upload'}`} style={{ marginLeft: 8 }}>
      {need === 'pro' ? 'TRADE' : 'GENIE'}
    </span>
  )

  return (
    <>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {error && <Notice tone="err" onClose={() => setError('')}>{error}</Notice>}
      <div className="card">
        <h2>Layout</h2>
        <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
          {STYLES.map((s) => {
            const isLocked = s.tier === 'pro' && locked('pro')
            const on = page.pageStyle === s.id
            return (
              <button key={s.id} type="button" disabled={busy}
                onClick={() => (isLocked ? setError('Page styles come with the Trade plan — everything here stays previewable, upgrading switches it on.') : save({ pageStyle: s.id }))}
                style={{
                  flex: '1 1 180px', textAlign: 'left', padding: 14, borderRadius: 12,
                  border: on ? '2px solid var(--accent, #c2410c)' : '1px solid var(--line)',
                  background: on ? 'rgba(194,65,12,.06)' : 'transparent',
                  opacity: isLocked ? 0.75 : 1, cursor: 'pointer',
                }}>
                <div className={`style-thumb ${s.id}`} aria-hidden="true" />
                <strong>{s.name}</strong>
                {on && <span className="chip ready" style={{ marginLeft: 8 }}>current</span>}
                {s.tier === 'pro' && isLocked && chip('pro')}
                <div className="meta" style={{ marginTop: 6 }}>{s.blurb}</div>
              </button>
            )
          })}
        </div>
        {page.pageStyle !== 'simple' && (
          <p className="meta mt">
            Sub-pages live at your address plus /services, /faq and /reviews — on your custom
            domain too. Each carries its own Google listing data.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Blocks{locked('pro') && chip('pro')}</h2>
        <p className="meta">
          Drag (or use the arrows) to reorder{locked('pro') && ' — reordering comes with Trade'}.
          The eye hides a block without losing its content.
        </p>
        {page.blocks.map((b, i) => (
          <div key={b.id} className="row" draggable={!locked('pro')}
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag != null && drag !== i) move(drag, i); setDrag(null) }}
            style={{
              border: '1px solid var(--line)', borderRadius: 9, padding: '8px 10px', marginTop: 7,
              opacity: b.visible ? 1 : 0.5, cursor: locked('pro') ? 'default' : 'grab',
            }}>
            <span className="meta" aria-hidden>⠿</span>
            <strong className="grow">{BLOCK_LABEL[b.id]}</strong>
            <button className="ghost" disabled={busy || locked('pro')} aria-label={`Move ${BLOCK_LABEL[b.id]} up`}
              onClick={() => move(i, i - 1)}>↑</button>
            <button className="ghost" disabled={busy || locked('pro')} aria-label={`Move ${BLOCK_LABEL[b.id]} down`}
              onClick={() => move(i, i + 1)}>↓</button>
            <button className="ghost" disabled={busy}
              onClick={() => save({ blocks: page.blocks.map((x) => x.id === b.id ? { ...x, visible: !x.visible } : x) })}>
              {b.visible ? '👁 shown' : '🚫 hidden'}
            </button>
          </div>
        ))}
      </div>

      <FaqEditor page={page} tier={tier} busy={busy} save={save} chip={chip} locked={locked} />

      <div className="card">
        <h2>Colours{locked('pro') && chip('pro')}</h2>
        <p className="meta">Laid over your chosen theme. Accent colour stays on the Edit page tab — it is free.</p>
        <div className="row">
          {(['paper', 'ink', 'button'] as const).map((k) => (
            <div key={k}>
              <label htmlFor={`pal-${k}`}>{k === 'paper' ? 'Background' : k === 'ink' ? 'Text' : 'Buttons'}</label>
              <input id={`pal-${k}`} type="color" className="swatch" disabled={busy || locked('pro')}
                value={page.palette?.[k] ?? (k === 'paper' ? '#ffffff' : k === 'ink' ? '#1c1917' : '#c2410c')}
                onChange={(e) => save({ palette: { ...page.palette, [k]: e.target.value } })} />
            </div>
          ))}
          <div style={{ alignSelf: 'flex-end' }}>
            <button className="ghost" disabled={busy || locked('pro') || !page.palette}
              onClick={() => save({ palette: null as never })}>Reset to theme</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Fonts{locked('genie') && chip('genie')}</h2>
        <p className="meta">Curated pairings that stay fast and readable. Part of the Genie plan's fully branded page.</p>
        <select disabled={busy || locked('genie')} value={page.fontPair ?? 'system'}
          onChange={(e) => save({ fontPair: e.target.value })} aria-label="Font pairing" style={{ maxWidth: 340 }}>
          {FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {locked('genie') && (
          <p className="meta mt">Fonts unlock with Genie. <Link to="/billing">See plans</Link></p>
        )}
      </div>

      {(
        <div className="card">
          <h2>Version history</h2>
          <p className="meta">Every save is kept (newest 20). Restoring never loses anything — the restore itself becomes the newest version.</p>
          {!versions ? <Skeleton rows={3} /> : versions.length === 0 ? (
            <p className="meta">Your first save will appear here.</p>
          ) : versions.map((v) => (
            <div key={v.sk} className="row" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span className="grow">{when(v.at)} <span className="meta">· {v.style}{v.label !== 'saved' ? ` · ${v.label}` : ''}</span></span>
              <button className="ghost" disabled={busy}
                onClick={() => {
                  setBusy(true); setError('')
                  void api('POST', '/v1/presence/versions/restore', { sk: v.sk })
                    .then(() => { setNote('Restored.'); return load() })
                    .catch((e) => setError(explain(e)))
                    .finally(() => setBusy(false))
                }}>
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function FaqEditor({ page, tier, busy, save, chip, locked }: {
  page: PageSettings
  tier: Tier
  busy: boolean
  save: (p: Partial<PageSettings>) => void
  chip: (n: 'pro' | 'genie') => JSX.Element
  locked: (n: 'pro' | 'genie') => boolean
}) {
  const [items, setItems] = useState(page.faq)
  useEffect(() => { setItems(page.faq) }, [page.faq])
  const isLocked = locked('pro')

  return (
    <div className="card">
      <h2>FAQ{isLocked && chip('pro')}</h2>
      <p className="meta">
        Questions your customers actually ask, answered in your words. Shown on the page
        {page.pageStyle !== 'simple' ? ' and on its own /faq page Google can index.' : '.'}
      </p>
      {isLocked ? (
        <p className="meta">The FAQ comes with the Trade plan. <Link to="/billing">See plans</Link></p>
      ) : (
        <>
          {items.map((f, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginTop: 10 }}>
              <div className="row">
                <input className="grow" maxLength={120} placeholder="Do you charge a call-out fee?"
                  value={f.q} aria-label={`Question ${i + 1}`}
                  onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} />
                <button className="danger" disabled={busy}
                  onClick={() => save({ faq: items.filter((_, j) => j !== i) })}>Remove</button>
              </div>
              <textarea rows={2} maxLength={1200} placeholder="The answer, in your words."
                value={f.a} aria-label={`Answer ${i + 1}`} style={{ marginTop: 8 }}
                onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} />
            </div>
          ))}
          <GenieDraftBar
            fields={['faq']}
            label="✨ Draft answers with Genie"
            onApply={(d) => {
              if (d.faq?.length) setItems(d.faq)
            }}
          />
          <div className="row mt">
            {items.length < 20 && (
              <button className="ghost" disabled={busy}
                onClick={() => setItems([...items, { q: '', a: '' }])}>Add a question</button>
            )}
            <button disabled={busy || JSON.stringify(items) === JSON.stringify(page.faq)}
              onClick={() => save({ faq: items })}>
              {busy ? 'Saving…' : 'Save FAQ'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

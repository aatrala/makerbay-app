import { useEffect, useState } from 'react'
import { Notice } from '@makerbay/web-kit'
import { adminApi, explainAdmin } from '../api'

/**
 * Who MakerBay says it is in every email it sends (issue 131).
 *
 * Read-only on purpose. The sign-up email is rendered at CDK synth time and
 * baked into the Cognito user pool, so it is a build artifact that no runtime
 * lookup can reach. An editable address here would leave that one email on the
 * old value until the next deploy while the other 21 moved - the same class of
 * quiet disagreement this page exists to make visible.
 *
 * The footers are rendered by the API calling the real footer functions rather
 * than described here, so the screen cannot drift from the inbox.
 */

interface Platform {
  identity: {
    legalEntityName: string
    productName: string
    postalAddress: string
    supportEmail: string
  }
  note: string
  footers: { owner: string[]; customer: string[] }
}

const FIELDS: Array<[keyof Platform['identity'], string, string]> = [
  ['productName', 'Product name', 'What customers call it.'],
  ['legalEntityName', 'Legal entity', 'The company that exists on paper and carries the liability.'],
  ['postalAddress', 'Postal address', 'Required in every email by CAN-SPAM, CASL and the EU regime.'],
  ['supportEmail', 'Support address', 'A monitored inbox, never a no-reply.'],
]

export default function Platform() {
  const [p, setP] = useState<Platform | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi('GET', '/admin/v1/platform').then(setP).catch((e) => setError(explainAdmin(e)))
  }, [])

  return (
    <>
      <h1>Platform identity</h1>
      <p className="meta">
        Every email this product sends carries these details. They identify the
        sender of record, which every market we send to requires, and they are
        identical across all 22 templates.
      </p>

      {error && <Notice tone="err">{error}</Notice>}
      {!p && !error && <p className="meta">Loading…</p>}

      {p && (
        <>
          <section className="card">
            <dl className="facts">
              {FIELDS.map(([k, label, hint]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{label}</dt>
                  <dd>
                    <strong>{p.identity[k]}</strong>
                    <br />
                    <span className="meta">{hint}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <Notice>
            <strong>Read-only.</strong> {p.note} The sign-up email is built into
            the Cognito user pool at deploy time, so a value changed here could
            never reach it. All 22 templates move together, or one of them
            silently disagrees with the rest.
          </Notice>

          <h2 className="mt">What this looks like in a footer</h2>
          <p className="meta">
            Rendered by the same functions that send the mail, so this is what
            lands in the inbox.
          </p>

          <section className="card">
            <h3>To a business owner</h3>
            <pre className="code">{p.footers.owner.join('\n')}</pre>

            <h3 className="mt">To their customer</h3>
            <pre className="code">{p.footers.customer.join('\n')}</pre>

            <p className="meta mt">
              The customer footer names both parties and the relationship
              between them. Canada&rsquo;s anti-spam law requires all three when
              you send on somebody else&rsquo;s behalf, and it is the strictest
              of the regimes we ship to.
            </p>
          </section>
        </>
      )}
    </>
  )
}

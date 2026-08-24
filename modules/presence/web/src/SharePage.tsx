import { useState } from 'react'
import { Notice, type Me } from '@makerbay/web-kit'
import QrBlock from './Qr'

/**
 * Put your links where your customers already are. Every network gets plain
 * numbered steps and, where the network supports it, a prefilled share
 * button - because "promote your page" should not require marketing skills.
 */
export default function SharePage({ me }: { me: Me }) {
  const slug = me.tenant?.slug ?? ''
  const business = me.tenant?.name ?? 'My business'
  const pageUrl = `https://makerbay.app/p/${slug}`
  const chatUrl = `https://chat.makerbay.app/${slug}`
  const bookUrl = `https://chat.makerbay.app/booking?slug=${slug}`
  const [note, setNote] = useState('')

  const copy = (label: string, value: string) =>
    void navigator.clipboard.writeText(value).then(() => setNote(`${label} copied.`))

  const shareText = `Book ${business} online, or ask us anything - we answer instantly:`

  const LINKS = [
    { label: 'Your page', value: pageUrl, hint: 'Everything in one place: services, prices, reviews, booking.' },
    { label: 'Chat link', value: chatUrl, hint: 'Straight into a conversation with your assistant.' },
    { label: 'Booking link', value: bookUrl, hint: 'Straight to picking a time.' },
  ]

  const CHANNELS: Array<{
    name: string
    steps: string[]
    action?: { label: string; href: string }
  }> = [
    {
      name: 'WhatsApp',
      steps: [
        'Open WhatsApp Business → Settings → Business tools → Business profile.',
        `Paste your page link into the Website field: ${pageUrl}`,
        'Optionally post it to your Status so existing customers see it once.',
        'From now on, anyone viewing your profile can tap through, ask a question and book a slot.',
      ],
      action: {
        label: 'Share on WhatsApp now',
        href: `https://wa.me/?text=${encodeURIComponent(`${shareText} ${pageUrl}`)}`,
      },
    },
    {
      name: 'LinkedIn',
      steps: [
        'On your profile, tap Edit → Contact info → add your page link as Website.',
        'Better: use the Featured section - add a link, paste your page URL, and it shows as a card at the top of your profile.',
        'If you have a company page, set the Custom button to "Visit website" with your page link.',
      ],
      action: {
        label: 'Share a post on LinkedIn',
        href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`,
      },
    },
    {
      name: 'Telegram',
      steps: [
        'Open Telegram → Settings → tap your bio and add your page link.',
        'Pin a message with the link in any customer group you run.',
      ],
      action: {
        label: 'Share on Telegram',
        href: `https://t.me/share/url?url=${encodeURIComponent(pageUrl)}&text=${encodeURIComponent(shareText)}`,
      },
    },
    {
      name: 'Facebook & Instagram',
      steps: [
        'Facebook page: set the action button to "Book now" with your booking link, and put your page link in the About section.',
        'Instagram: paste your page link into your bio (the one clickable link). If you use a link-in-bio tool, add all three links above.',
      ],
      action: {
        label: 'Share on Facebook',
        href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`,
      },
    },
    {
      name: 'Google Business Profile',
      steps: [
        'In your Google Business Profile, set Website to your page link (or your own site if you have one).',
        'Set the Appointment link to your booking link - the Book button then appears right on your Google listing.',
        'The Get found module walks you through the full profile checklist.',
      ],
    },
    {
      name: 'Email signature, van & invoices',
      steps: [
        `Add one line to your email signature: "Book online: ${pageUrl}"`,
        'Put the address on your van, cards and printed invoices - it is short enough to type from a photo.',
      ],
    },
  ]

  return (
    <>
      <h1>Share your page</h1>
      <p>
        Put your links where your customers already are. Anyone who finds them can ask a
        question, check availability and book a slot - without phoning you.
      </p>
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}

      <div className="card">
        <h2>Your three links</h2>
        {LINKS.map((l) => (
          <div key={l.label}>
            <label className="mt">{l.label} <span className="meta">— {l.hint}</span></label>
            <div className="row">
              <input className="grow" readOnly value={l.value} onFocus={(e) => e.target.select()}
                aria-label={l.label} />
              <button className="ghost" onClick={() => copy(l.label, l.value)}>Copy</button>
            </div>
          </div>
        ))}
      </div>

      {CHANNELS.map((c) => (
        <div className="card" key={c.name}>
          <h2>{c.name}</h2>
          <ol className="share-steps">
            {c.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {c.action && (
            <p className="mt">
              <a className="btn" href={c.action.href} target="_blank" rel="noopener">{c.action.label}</a>
            </p>
          )}
        </div>
      ))}

      <div className="card">
        <h2>QR codes</h2>
        <p className="meta">Print-ready codes — one scan takes a customer straight there.</p>
        <QrBlock url={pageUrl} label="Your page" />
        <QrBlock url={bookUrl} label="Book a time" />
        <QrBlock url={chatUrl} label="Ask a question" />
      </div>

      <div className="card">
        <h2>Widget for your own website</h2>
        <p className="meta">
          If you have a website, the chat bubble is one line of HTML - find it under
          Assistant → Deploy. Everything above works with no website at all.
        </p>
      </div>
    </>
  )
}

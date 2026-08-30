// The barrel rather than the ./color subpath: infra/tsconfig.json uses
// classic `node` module resolution, which does not read an exports map, and
// the CDK app renders these templates at synth time.
import { accentOn, readableOn } from '@makerbay/core'
import type { Block, EmailDoc } from './blocks'

/**
 * One renderer, two outputs, one source.
 *
 * Email HTML is not web HTML. The constraints below are not caution, they are
 * measured: classic Outlook on Windows renders through the Word engine and
 * supports 59 of 307 tested CSS features, Gmail on a non-Google account
 * supports no `<style>` block at all, and Gmail strips an entire style
 * attribute that contains a `url()`. So: tables for layout, inline styles for
 * anything structural, a `<style>` block only for the things that cannot be
 * inlined, 600px fixed, no web fonts, no background images.
 */

/**
 * The one HTML escaper. Exported because four other copies of it had grown
 * around the codebase, and an escaping fix applied to one copy and not the
 * rest is an XSS-relevant gap, not a style nit.
 */
export const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Only http(s) survives. A javascript: or data: href in an email is an attack. */
const safeHref = (raw: string): string => {
  const url = String(raw ?? '').trim()
  return /^https?:\/\//i.test(url) ? esc(url) : '#'
}

const SANS = "'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace"

/** Wrap at 72, the width a plain-text mail client has always assumed. */
function wrap(text: string, width = 72): string {
  const out: string[] = []
  for (const para of String(text ?? '').split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'para':
    case 'lede':
      return wrap(b.text)
    case 'note':
      return wrap(b.text)
    case 'button':
    case 'link':
      // The URL in full. A text-only reader must still reach the quote.
      return `${b.label}: ${b.href}`
    case 'rows':
      return b.rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    case 'total':
      return `${b.label.toUpperCase()}: ${b.value}`
    case 'code':
      return b.value
    case 'rule':
      return ''
  }
}

function blockHtml(b: Block, accent: string): string {
  const pad = 'padding:0 24px;'
  const p = `margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:1.55;color:#292524;`
  switch (b.t) {
    case 'lede':
      return `<tr><td class="mb-pad" style="${pad}"><p class="mb-ink" style="${p}font-size:17px;color:#1c1917;">${esc(b.text)}</p></td></tr>`
    case 'para':
      return `<tr><td class="mb-pad" style="${pad}"><p class="mb-body" style="${p}">${esc(b.text)}</p></td></tr>`
    case 'note':
      return `<tr><td class="mb-pad" style="${pad}"><p class="mb-mute" style="${p}font-size:14px;color:#78716c;">${esc(b.text)}</p></td></tr>`
    case 'rows':
      return `<tr><td class="mb-pad" style="${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">${
        b.rows.map(([k, v]) =>
          `<tr><td class="mb-mute" style="font-family:${SANS};font-size:15px;line-height:1.5;color:#78716c;padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;">${esc(k)}</td>`
          + `<td class="mb-body" style="font-family:${SANS};font-size:15px;line-height:1.5;color:#292524;padding:3px 0;">${esc(v)}</td></tr>`,
        ).join('')
      }</table></td></tr>`
    case 'total':
      return `<tr><td class="mb-pad" style="${pad}"><p class="mb-ink" style="${p}font-weight:700;">${esc(b.label)}: ${esc(b.value)}</p></td></tr>`
    case 'code':
      // Selectable text, never an image. Someone reading this needs to copy it.
      return `<tr><td class="mb-pad" style="${pad}"><p class="mb-ink" style="margin:0 0 14px;font-family:${MONO};font-size:30px;letter-spacing:6px;font-weight:700;color:#1c1917;">${esc(b.value)}</p></td></tr>`
    case 'rule':
      return `<tr><td class="mb-pad" style="${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mb-rule" style="border-top:1px solid #e7e5e4;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`
    case 'link':
      return `<tr><td class="mb-pad" style="${pad}"><p style="${p}"><a class="mb-a" href="${safeHref(b.href)}" style="color:${accent};text-decoration:underline;">${esc(b.label)}</a></p></td></tr>`
    case 'button': {
      // Conditional-padding anchor, not VML: the whole button is clickable and
      // it does not break a screen reader. 13 + 18 + 13 = 44px, the touch
      // target the design guidelines require. Outlook renders square corners.
      const fg = readableOn(accent)
      return `<tr><td class="mb-pad" style="${pad}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 16px;"><tr><td>`
        + `<a href="${safeHref(b.href)}" style="display:inline-block;min-width:160px;box-sizing:border-box;padding:13px 22px;border-radius:6px;background:${accent};font-family:${SANS};font-size:15px;font-weight:600;line-height:18px;text-align:center;color:${fg};text-decoration:none;mso-padding-alt:0;">`
        + `<!--[if mso]><i style="mso-font-width:150%;mso-text-raise:26px;" hidden>&emsp;</i><![endif]-->`
        + `<span style="mso-text-raise:13px;">${esc(b.label)}</span>`
        + `<!--[if mso]><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]-->`
        + `</a></td></tr></table></td></tr>`
    }
  }
}

export interface Rendered {
  subject: string
  html: string
  text: string
}

export function renderEmail(doc: EmailDoc, footerLines: string[]): Rendered {
  const accent = /^#[0-9a-fA-F]{6}$/.test(doc.brand.accent) ? doc.brand.accent : '#c2410c'
  const accentDark = accentOn(accent, '#292524')

  /**
   * The unsubscribe line, when the document declares one (issue 121).
   *
   * `EmailDoc.unsubscribe` was declared and then read by nothing, so a
   * template could ask for an unsubscribe and silently not get one. Only
   * `optional` mail sets it: a review ask, the digest. Never an invoice.
   *
   * Last in the footer on purpose - present and findable, not competing with
   * the business's own name and number directly above it.
   */
  const unsubLine = doc.unsubscribe ? 'Stop getting these emails' : undefined
  const lines = unsubLine ? [...footerLines, unsubLine] : footerLines

  const text = [
    doc.heading,
    '',
    ...doc.blocks.map(blockText).filter((s) => s !== ''),
    '',
    '---',
    // The text part spells the address out: there is no anchor to click in a
    // plain-text client, so a bare label would be a dead end.
    //
    // Footer prose is wrapped like body prose, but a line carrying a URL is
    // left alone: a URL broken across two lines cannot be copied out of a
    // plain-text client, which is worse than a long line. This was latent
    // while the longest footer line was 67 characters and the limit was 72.
    ...(
      doc.unsubscribe
      ? [...footerLines, `Stop getting these emails: ${doc.unsubscribe.url}`]
      : footerLines
    ).map((l) => (l.includes('http') ? l : wrap(l))),
  ].join('\n').replace(/\n{3,}/g, '\n\n')

  const html = `<!doctype html>
<html lang="en" style="color-scheme:light dark;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(doc.subject)}</title>
<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    .mb-bg { background:#171412 !important; }
    .mb-card { background:#292524 !important; border-color:#44403c !important; }
    .mb-ink { color:#f5f5f4 !important; }
    .mb-body { color:#d6d3d1 !important; }
    .mb-mute { color:#a8a29e !important; }
    .mb-a { color:${accentDark} !important; }
    .mb-rule { border-color:#44403c !important; }
  }
  /* Outlook.com and Outlook mobile invert partially and expose these hooks.
     The attribute has to be repeated on every selector: Outlook.com drops the
     ones that do not carry it. */
  [data-ogsc] .mb-ink { color:#f5f5f4 !important; }
  [data-ogsc] .mb-body { color:#d6d3d1 !important; }
  [data-ogsc] .mb-mute { color:#a8a29e !important; }
  [data-ogsc] .mb-a { color:${accentDark} !important; }
  [data-ogsb] .mb-card { background:#292524 !important; }
  [data-ogsb] .mb-bg { background:#171412 !important; }
  @media (max-width:620px) {
    .mb-shell { width:100% !important; }
    .mb-pad { padding-left:16px !important; padding-right:16px !important; }
  }
</style>
</head>
<body class="mb-bg" style="margin:0;padding:0;background:#faf9f7;">
<div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#faf9f7;">${esc(doc.preheader)}&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;</div>
<table role="presentation" class="mb-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f7;">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="mb-shell mb-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#fffffe;border:1px solid #e7e5e4;border-radius:10px;">
  <!-- The brand is a 4px rule, never a filled band. Under forced inversion a
       rule changing colour is damage nobody sees; a 200px header is an email
       that looks broken. -->
  <tr><td style="height:4px;line-height:4px;font-size:0;background:${accent};border-radius:10px 10px 0 0;">&nbsp;</td></tr>
  <tr><td class="mb-pad" style="padding:20px 24px 0;">
    <div class="mb-ink" style="font-family:${SANS};font-size:15px;font-weight:600;color:#1c1917;">${esc(doc.brand.name)}</div>
  </td></tr>
  <tr><td class="mb-pad" style="padding:14px 24px 0;">
    <h1 class="mb-ink" style="margin:0 0 12px;font-family:${SANS};font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-0.01em;color:#1c1917;">${esc(doc.heading)}</h1>
  </td></tr>
${doc.blocks.map((b) => blockHtml(b, accent)).join('\n')}
  <tr><td class="mb-pad" style="padding:10px 24px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mb-rule" style="border-top:1px solid #e7e5e4;font-size:0;line-height:0;">&nbsp;</td></tr></table>
    <p class="mb-mute" style="margin:12px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:#a8a29e;">${
      lines.map((l) => (l === unsubLine && doc.unsubscribe
        ? `<a href="${safeHref(doc.unsubscribe.url)}" style="color:#a8a29e;text-decoration:underline;">${esc(l)}</a>`
        : esc(l))).join('<br>')
    }</p>
  </td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`

  return { subject: doc.subject, html, text }
}

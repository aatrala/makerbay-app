/**
 * Page counting, first-party, no cookies (issue 145).
 *
 * There was no analytics of any kind, which meant no experiment on this site
 * could be evaluated and no claim about it could be checked. The obvious fix
 * is a hosted script from Plausible or similar - and it is not available,
 * because the privacy policy promises "no cookies, no third-party tracker of
 * any kind" and a build-failing test enforces that against ten hosts. So this
 * is ours, and small enough to read in a minute.
 *
 * What it sends: the path, and the HOST of the referrer, once per page load.
 * What it does not send: no cookie, no identifier, no fingerprint, no
 * localStorage, nothing that survives the request, and never a full referring
 * URL - the host is enough to tell a search engine from a forum, and the
 * query string of the page somebody came from is none of our business.
 *
 * The result is a daily count per path. It cannot follow one person around,
 * which is the point, and is also why it needs no banner.
 */
(function () {
  try {
    // Do not count the author. Also skips file:// and any local build.
    if (location.hostname !== 'makerbay.app') return
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return

    var path = location.pathname.replace(/\/+$/, '') || '/'
    // Bounded: an unexpected path should never write an unbounded key.
    if (path.length > 80) path = path.slice(0, 80)

    var ref = ''
    if (document.referrer) {
      try {
        var h = new URL(document.referrer).hostname
        if (h && h !== location.hostname) ref = h.slice(0, 60)
      } catch (e) { /* an unparseable referrer is simply no referrer */ }
    }

    var url = 'https://api.makerbay.app/v1/public/presence?stat='
      + encodeURIComponent(path) + (ref ? '&ref=' + encodeURIComponent(ref) : '')

    // sendBeacon survives the page being closed, which a fetch on unload does
    // not. Falls back to a keepalive fetch where it is missing.
    if (navigator.sendBeacon) navigator.sendBeacon(url)
    else fetch(url, { method: 'GET', keepalive: true, mode: 'no-cors' })
  } catch (e) {
    // Counting must never break a page. There is nothing to report to.
  }
})()

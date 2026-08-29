/**
 * The hero field: paste an address, get a real page back.
 *
 * Two things this deliberately does NOT do. It does not ask for an account or
 * a card, because the whole argument is that you see the work before you owe
 * anything. And it does not show a spinner: the twenty to sixty seconds while
 * the page is read is the most valuable screen on the site, so it narrates
 * what is actually happening. A grounded, honest assistant is easier to
 * demonstrate than to describe.
 */
(function () {
  var form = document.getElementById('hero-setup')
  if (!form) return

  var input = document.getElementById('hero-url')
  var button = form.querySelector('button')
  var out = document.getElementById('hero-result')
  var API = 'https://api.makerbay.app/v1/public/setup/draft'

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  var steps = [
    'Reading the page',
    'Working out what it says about the business',
    'Drafting your page',
  ]
  var timer = null

  function narrate(host) {
    var i = 0
    host.innerHTML = '<p class="hero-step">' + esc(steps[0]) + '</p>'
    timer = setInterval(function () {
      i += 1
      if (i >= steps.length) return
      host.insertAdjacentHTML('beforeend', '<p class="hero-step">' + esc(steps[i]) + '</p>')
    }, 4000)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var url = (input.value || '').trim()
    if (url.length < 4) return

    button.disabled = true
    input.disabled = true
    out.hidden = false
    narrate(out)

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url }),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b } }) })
      .then(function (r) {
        stop()
        if (r.status === 429) {
          out.innerHTML =
            '<p class="hero-note">' + esc(r.body.message || 'Try again tomorrow.') + '</p>' +
            '<p><a class="btn" href="https://app.makerbay.app">Start free instead</a></p>'
          return
        }
        if (!r.body || r.body.ok === false || !r.body.draft) {
          // Saying so is the honest answer. A made-up page is worse than none.
          out.innerHTML =
            '<p class="hero-note">' + esc((r.body && r.body.message) || 'We could not read that address.') + '</p>' +
            '<p><a class="btn" href="https://app.makerbay.app">Start free instead</a></p>'
          return
        }

        // The page itself, not a list of the fields that went into it.
        //
        // The headline above this promises "get a page back", and for months
        // what came back was a table of extracted values. It is rendered by
        // the same function that serves every live MakerBay page, in an
        // iframe so its styles cannot touch this one, and scaled down so a
        // desktop-width page fits the column.
        var preview = 'https://api.makerbay.app/v1/public/presence?preview=' +
          encodeURIComponent(r.body.token)

        out.innerHTML =
          '<h2 class="hero-built">Here is your page</h2>' +
          '<p class="hero-note">Read from ' + esc(r.body.draft.url) +
          '. Nothing is public and nobody can see this but you.</p>' +
          '<div class="hero-preview"><iframe title="A preview of your page" ' +
          'loading="lazy" sandbox="allow-same-origin" src="' + esc(preview) + '"></iframe></div>' +
          '<p class="hero-note">Everything on it is editable, and nothing is ' +
          'published until you say so. Keep this link to pick it up where you ' +
          'left off - it works for two weeks.</p>' +
          '<p><a class="btn lg" href="https://app.makerbay.app/setup?claim=' +
          encodeURIComponent(r.body.token) + '">Make it mine</a></p>' +
          '<p><small>You can do all of this yourself in the app too. It takes about ten minutes.</small></p>'
      })
      .catch(function () {
        stop()
        out.innerHTML =
          '<p class="hero-note">Something went wrong at our end, and nothing was saved. ' +
          'Try again, or start free and paste your details in the app.</p>'
      })
      .then(function () {
        button.disabled = false
        input.disabled = false
      })
  })
})()

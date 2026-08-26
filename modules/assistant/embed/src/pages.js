/**
 * Customer-facing pages on the chat surface, beyond the chat itself:
 *   /booking?slug=...             pick a service, a day and a real free slot
 *   /booking/cancel?slug=&token=  view or cancel a booking, no account needed
 *   /quote?slug=&token=           view a quote and accept or decline it
 *   /review?slug=&token=          leave a review after a finished job
 *   /invoice?slug=&token=         view a themed, printable invoice
 *
 * Same rules as chat.js: vanilla JS, text via textContent unless the markup
 * is entirely ours, and every failure ends in a message a person can act on.
 */
;(function () {
  var API = 'https://api.makerbay.app'
  var app = document.getElementById('app')
  var params = new URLSearchParams(location.search)
  var slug = params.get('slug') || ''
  var token = params.get('token') || ''
  var path = location.pathname.replace(/\/+$/, '')

  document.body.classList.add('hosted', 'page')

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fail(message) {
    app.className = 'error'
    app.textContent = message
  }

  function money(cents, currency) {
    try {
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency || 'AUD' })
        .format(cents / 100)
    } catch (e) {
      return '$' + (cents / 100).toFixed(2)
    }
  }

  function get(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d } })
    })
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d } })
    })
  }

  if (!slug) return fail('This link is not valid.')

  // The business's accent colour, so the booking, quote, review and invoice
  // pages look like the page that linked here - not a different blue product.
  fetch(API + '/v1/public/assistant/config?slug=' + encodeURIComponent(slug))
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (d) {
      var c = d && d.assistant && d.assistant.brandColor
      if (c && /^#[0-9a-fA-F]{6}$/.test(c)) {
        document.documentElement.style.setProperty('--brand', c)
        var n = parseInt(c.slice(1), 16)
        var lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)
        document.documentElement.style.setProperty('--brand-fg', lum > 186 ? '#1c1917' : '#fff')
      }
    })
    .catch(function () { /* default colour is fine */ })

  if (path === '/booking') return bookingPage()
  if (path === '/booking/cancel') return cancelPage()
  if (path === '/quote') return quotePage()
  if (path === '/review') return reviewPage()
  if (path === '/invoice') return invoicePage()
  return fail('This link is not valid.')

  // ── Booking ────────────────────────────────────────────────────────────

  function bookingPage() {
    // Returning from a deposit payment: the URL carries the booking token.
    // The browser is not a source of truth - read the row's real state.
    if (token) return depositReturn(0)

    get(API + '/v1/public/booking/services?slug=' + encodeURIComponent(slug))
      .then(function (res) {
        if (res.status !== 200) return fail('Online booking is not available for this business.')
        var info = res.data
        document.title = 'Book — ' + (info.business || '')
        app.className = ''

        var state = { serviceId: '', date: '', slot: null }

        function head(sub) {
          return '<header><div class="name">' + esc(info.business || 'Book a time') + '</div></header>' +
            '<div class="page-body">' +
            (sub ? '<p class="lead">' + esc(sub) + '</p>' : '')
        }
        var foot = '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

        function stepService() {
          if (!info.services.length) return fail('Nothing can be booked online right now. Please call instead.')
          app.innerHTML = head(info.intro || 'Pick a service.') +
            '<div class="choices">' +
            info.services.map(function (s) {
              return '<button class="choice" data-id="' + esc(s.serviceId) + '">' +
                '<span class="c-name">' + esc(s.name) + '</span>' +
                (s.description ? '<span class="c-desc">' + esc(s.description) + '</span>' : '') +
                '<span class="c-meta">' + (s.priceCents != null ? money(s.priceCents) + ' · ' : '') + s.durationMinutes + ' min' +
                (s.depositCents ? ' · ' + money(s.depositCents) + ' deposit' : '') + '</span>' +
                '</button>'
            }).join('') +
            '</div>' + foot
          app.querySelectorAll('.choice').forEach(function (b) {
            b.addEventListener('click', function () {
              state.serviceId = b.getAttribute('data-id')
              stepDate()
            })
          })
        }

        function stepDate() {
          if (!info.dates.length) return fail('No days are open for booking at the moment. Please call instead.')
          app.innerHTML = head('Pick a day.') +
            '<div class="choices">' +
            info.dates.map(function (d) {
              var label = new Date(d + 'T12:00:00').toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long',
              })
              return '<button class="choice" data-d="' + esc(d) + '"><span class="c-name">' + esc(label) + '</span></button>'
            }).join('') +
            '</div><p class="back"><a href="#" id="back">Back</a></p>' + foot
          app.querySelector('#back').addEventListener('click', function (e) { e.preventDefault(); stepService() })
          app.querySelectorAll('.choice').forEach(function (b) {
            b.addEventListener('click', function () {
              state.date = b.getAttribute('data-d')
              stepSlot()
            })
          })
        }

        function stepSlot() {
          app.innerHTML = head('Finding free times…') + foot
          get(API + '/v1/public/booking/slots?slug=' + encodeURIComponent(slug) +
              '&serviceId=' + encodeURIComponent(state.serviceId) + '&date=' + encodeURIComponent(state.date))
            .then(function (res) {
              var slots = (res.status === 200 && res.data.slots) || []
              if (!slots.length) {
                app.innerHTML = head('Nothing free that day — try another.') +
                  '<p class="back"><a href="#" id="back">Pick a different day</a></p>' + foot
                app.querySelector('#back').addEventListener('click', function (e) { e.preventDefault(); stepDate() })
                return
              }
              app.innerHTML = head('Pick a time. Shown in the business’s own timezone.') +
                '<div class="choices slots">' +
                slots.map(function (s, i) {
                  return '<button class="choice slot" data-i="' + i + '">' + esc(s.label) + '</button>'
                }).join('') +
                '</div><p class="back"><a href="#" id="back">Back</a></p>' + foot
              app.querySelector('#back').addEventListener('click', function (e) { e.preventDefault(); stepDate() })
              app.querySelectorAll('.slot').forEach(function (b) {
                b.addEventListener('click', function () {
                  state.slot = slots[Number(b.getAttribute('data-i'))]
                  stepDetails()
                })
              })
            })
        }

        function stepDetails() {
          var svc = info.services.filter(function (s) { return s.serviceId === state.serviceId })[0] || {}
          var dep = svc.depositCents || 0
          app.innerHTML = head('Nearly done — how do we reach you?') +
            '<form id="bform" class="pform">' +
            '<label>Your name</label><input id="f-name" autocomplete="name" />' +
            '<label>Email</label><input id="f-email" type="email" autocomplete="email" />' +
            '<label>Phone</label><input id="f-phone" type="tel" autocomplete="tel" />' +
            '<label>Anything we should know? (optional)</label><textarea id="f-note" rows="2"></textarea>' +
            '<p class="hint">Email or phone — whichever suits. The confirmation goes there.</p>' +
            '<button class="primary" type="submit">' +
            (dep ? 'Confirm and pay the ' + money(dep) + ' deposit' : 'Confirm booking') +
            '</button>' +
            (dep ? '<p class="hint">Secure card payment via Stripe, straight to ' + esc(info.business || 'the business') + '. Refundable at their discretion.</p>' : '') +
            '<p class="form-err" id="f-err"></p>' +
            '</form><p class="back"><a href="#" id="back">Back</a></p>' + foot
          app.querySelector('#back').addEventListener('click', function (e) { e.preventDefault(); stepSlot() })
          app.querySelector('#bform').addEventListener('submit', function (e) {
            e.preventDefault()
            var err = document.getElementById('f-err')
            err.textContent = ''
            var payload = {
              slug: slug,
              serviceId: state.serviceId,
              startsAt: state.slot.startsAt,
              name: document.getElementById('f-name').value.trim(),
              email: document.getElementById('f-email').value.trim(),
              phone: document.getElementById('f-phone').value.trim(),
              note: document.getElementById('f-note').value.trim(),
            }
            if (!payload.email && !payload.phone) {
              err.textContent = 'Leave an email or a phone number so the booking can be confirmed.'
              return
            }
            var btn = app.querySelector('.primary')
            btn.disabled = true
            btn.textContent = 'Booking…'
            post(API + '/v1/public/booking', payload).then(function (res) {
              if (res.status === 201 && res.data.depositRequired) return payDeposit(res.data, btn)
              if (res.status === 201) return stepDone(res.data)
              btn.disabled = false
              btn.textContent = 'Confirm booking'
              if (res.status === 409) {
                err.textContent = 'That time has just been taken. Pick another and we will hold it.'
                setTimeout(stepSlot, 1500)
              } else {
                err.textContent = (res.data && res.data.message) || 'That did not work. Try again.'
              }
            })
          })
        }

        function stepDone(data) {
          var b = data.booking || {}
          app.innerHTML = head('') +
            '<div class="done">' +
            '<div class="tick">&#10003;</div>' +
            '<h2>Booked</h2>' +
            '<p>' + esc(b.serviceName || '') + '<br />' + esc(b.date || '') + ' at ' + esc(b.time || '') + '</p>' +
            (data.emailed
              ? '<p class="hint">A confirmation email is on its way, with a link if you need to cancel.</p>'
              : '<p class="hint">Note the time down — the confirmation email could not be sent.</p>') +
            '</div>' + foot
        }

        // The slot is held; Stripe takes it from here (spec-booking-deposits.md).
        function payDeposit(data, btn) {
          btn.textContent = 'Opening secure payment…'
          post(API + '/v1/public/payments/session', {
            slug: slug, kind: 'booking_deposit', token: data.token,
          }).then(function (res) {
            if (res.status === 200 && res.data.url) { location.href = res.data.url; return }
            btn.disabled = false
            btn.textContent = 'Try the payment again'
            var err = document.getElementById('f-err')
            if (err) err.textContent = (res.data && res.data.message) || 'The payment page could not be opened. Your slot is held for a few more minutes — try again.'
            btn.onclick = function (e) { e.preventDefault(); btn.disabled = true; payDeposit(data, btn) }
          })
        }

        stepService()
      })
      .catch(function () { fail('Online booking is not available right now.') })
  }

  /**
   * Back from Stripe with a booking token. paid=pending means Stripe said
   * success — the webhook usually lands within seconds, so poll briefly.
   * Without it the customer backed out: the hold is still live for a bit.
   */
  function depositReturn(attempt) {
    var url = API + '/v1/public/booking/' + encodeURIComponent(token) + '?slug=' + encodeURIComponent(slug)
    get(url).then(function (res) {
      if (res.status !== 200) return fail('This booking could not be found.')
      var b = res.data.booking || {}
      document.title = 'Booking — ' + (res.data.business || '')
      app.className = ''
      var foot = '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'
      var headHtml = '<header><div class="name">' + esc(res.data.business || '') + '</div></header><div class="page-body">'

      if (b.status === 'confirmed') {
        app.innerHTML = headHtml +
          '<div class="done"><div class="tick">&#10003;</div><h2>Booked</h2>' +
          '<p>' + esc(b.serviceName || '') + '<br />' + esc(b.date || '') + ' at ' + esc(b.time || '') + '</p>' +
          (b.depositCents ? '<p class="hint">Deposit received: ' + money(b.depositCents) + '. A confirmation email is on its way.</p>' : '') +
          '</div>' + foot
        return
      }
      if (b.status === 'pending_payment' && params.get('paid') === 'pending' && attempt < 4) {
        app.innerHTML = headHtml + '<p class="lead">Payment received — confirming your booking…</p>' + foot
        setTimeout(function () { depositReturn(attempt + 1) }, 3000)
        return
      }
      if (b.status === 'pending_payment') {
        app.innerHTML = headHtml +
          '<p class="lead">Your ' + esc(b.serviceName || 'booking') + ' slot is held for a few more minutes.</p>' +
          '<p>Pay the ' + (b.depositCents ? money(b.depositCents) + ' ' : '') + 'deposit to secure ' + esc(b.date || '') + ' at ' + esc(b.time || '') + '.</p>' +
          '<button class="primary" id="payagain">Pay the deposit</button>' + foot
        document.getElementById('payagain').addEventListener('click', function () {
          this.disabled = true
          this.textContent = 'Opening secure payment…'
          var self = this
          post(API + '/v1/public/payments/session', { slug: slug, kind: 'booking_deposit', token: token })
            .then(function (r2) {
              if (r2.status === 200 && r2.data.url) { location.href = r2.data.url; return }
              self.disabled = false
              self.textContent = 'Pay the deposit'
              fail((r2.data && r2.data.message) || 'The payment could not be started. The time may have been released — book again.')
            })
        })
        return
      }
      fail('This booking is ' + esc(b.status || 'no longer available') + '.')
    })
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  function cancelPage() {
    if (!token) return fail('This link is not valid.')
    var url = API + '/v1/public/booking/' + encodeURIComponent(token) + '?slug=' + encodeURIComponent(slug)
    get(url).then(function (res) {
      if (res.status !== 200) return fail('This booking could not be found. It may already be cancelled.')
      var b = res.data.booking
      document.title = 'Your booking — ' + (res.data.business || '')
      app.className = ''
      var foot = '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'
      app.innerHTML =
        '<header><div class="name">' + esc(res.data.business || '') + '</div></header>' +
        '<div class="page-body"><div class="done">' +
        '<h2>' + esc(b.serviceName || 'Your booking') + '</h2>' +
        '<p>' + esc(b.date || '') + ' at ' + esc(b.time || '') + '</p>' +
        (b.status === 'cancelled'
          ? '<p class="hint">This booking is already cancelled.</p>'
          : '<button class="danger" id="cancel">Cancel this booking</button><p class="form-err" id="f-err"></p>') +
        '</div>' + foot
      var btn = document.getElementById('cancel')
      if (btn) btn.addEventListener('click', function () {
        if (!window.confirm('Cancel this booking?')) return
        btn.disabled = true
        post(url, {}).then(function (r) {
          if (r.status === 200) {
            app.querySelector('.done').innerHTML =
              '<div class="tick">&#10003;</div><h2>Cancelled</h2><p class="hint">The business has been told. Thanks for letting them know.</p>'
          } else {
            btn.disabled = false
            document.getElementById('f-err').textContent = 'That did not work. Try again, or phone the business.'
          }
        })
      })
    }).catch(function () { fail('This booking could not be loaded right now.') })
  }

  // ── Quote ──────────────────────────────────────────────────────────────

  function quotePage() {
    if (!token) return fail('This link is not valid.')
    var base = API + '/v1/public/quotes/' + encodeURIComponent(token)
    get(base + '?slug=' + encodeURIComponent(slug)).then(function (res) {
      if (res.status !== 200) return fail('This quote could not be found.')
      var q = res.data.quote
      var business = res.data.business || ''
      document.title = 'Quote ' + (q.label || '#' + q.number) + ' — ' + business
      app.className = ''
      var foot = (res.data.footer ? '<p class="doc-footer">' + esc(res.data.footer) + '</p>' : '') + '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

      var lines = q.lines.map(function (l) {
        return '<tr><td>' + esc(l.description) +
          '<span class="q-unit">' + l.quantity + ' ' + esc(l.unit) + ' × ' + money(l.unitCents, q.currency) + '</span></td>' +
          '<td class="num">' + money(l.totalCents, q.currency) + '</td></tr>'
      }).join('')

      var validUntil = new Date(q.validUntil).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      })

      var stateBlock
      if (q.status === 'accepted') {
        var depositBlock = ''
        if (q.deposit && q.deposit.paid) {
          depositBlock = '<p class="q-state ok">Deposit of ' + money(q.deposit.amountCents, q.currency) + ' paid. Thank you.</p>'
        } else if (q.deposit && q.deposit.payable) {
          depositBlock =
            '<div class="q-actions"><button class="primary" id="paydeposit">Pay the ' +
            money(q.deposit.amountCents, q.currency) + ' deposit</button></div>' +
            '<p class="hint">Secure card payment via Stripe. The money goes straight to ' + esc(business) + '.</p>' +
            '<p class="form-err" id="pay-err"></p>'
        }
        stateBlock = '<p class="q-state ok">Accepted' + (q.customerName ? ' by ' + esc(q.customerName) : '') + '. ' +
          esc(business) + ' has been told and will be in touch.</p>' + depositBlock
      } else if (q.status === 'declined') {
        stateBlock = '<p class="q-state">This quote was declined.</p>'
      } else if (q.status === 'expired') {
        stateBlock = '<p class="q-state">This quote expired on ' + esc(validUntil) + '. Ask ' + esc(business) + ' for an updated one.</p>'
      } else if (q.status === 'superseded') {
        stateBlock = '<p class="q-state">This quote has been replaced with an updated one.' +
          (q.supersededBy
            ? ' <a href="/quote?slug=' + encodeURIComponent(slug) + '&token=' + encodeURIComponent(q.supersededBy) + '">View the current quote</a>.'
            : '') +
          '</p>'
      } else {
        stateBlock =
          '<div class="q-actions">' +
          '<button class="primary" id="accept">Accept this quote</button>' +
          '<button class="ghost" id="decline">Decline</button>' +
          '</div>' +
          '<p class="hint">Valid until ' + esc(validUntil) + '. Accepting tells ' + esc(business) + ' to go ahead.</p>' +
          '<p class="form-err" id="f-err"></p>'
      }

      var qLogo = res.data.logoUrl
        ? '<img class="doc-logo" src="' + esc(res.data.logoUrl) + '" alt="" />'
        : ''
      app.innerHTML =
        '<header>' + qLogo + '<div class="name">' + esc(business) + '</div></header>' +
        '<div class="page-body">' +
        '<h2 class="q-title">Quote ' + esc(q.label || '#' + q.number) + (q.customerName ? ' for ' + esc(q.customerName) : '') + '</h2>' +
        '<table class="q-lines"><tbody>' + lines + '</tbody>' +
        '<tfoot>' +
        '<tr><td>Subtotal</td><td class="num">' + money(q.subtotalCents, q.currency) + '</td></tr>' +
        (q.taxCents > 0 ? '<tr><td>' + esc(res.data.quote.taxLabel || q.taxLabel || 'Tax') + '</td><td class="num">' + money(q.taxCents, q.currency) + '</td></tr>' : '') +
        '<tr class="q-total"><td>Total</td><td class="num">' + money(q.totalCents, q.currency) + '</td></tr>' +
        '</tfoot></table>' +
        (q.notes ? '<p class="q-notes">' + esc(q.notes) + '</p>' : '') +
        (q.terms ? '<p class="q-terms">' + esc(q.terms) + '</p>' : '') +
        stateBlock + foot

      function respond(decision) {
        var err = document.getElementById('f-err')
        err.textContent = ''
        app.querySelectorAll('button').forEach(function (b) { b.disabled = true })
        post(base + '/respond?slug=' + encodeURIComponent(slug), { slug: slug, decision: decision })
          .then(function (r) {
            if (r.status === 200) return quotePage()
            app.querySelectorAll('button').forEach(function (b) { b.disabled = false })
            err.textContent = (r.data && r.data.message) || 'That did not work. Try again.'
          })
      }
      var acceptBtn = document.getElementById('accept')
      if (acceptBtn) acceptBtn.addEventListener('click', function () { respond('accept') })
      var declineBtn = document.getElementById('decline')
      if (declineBtn) declineBtn.addEventListener('click', function () {
        if (window.confirm('Decline this quote?')) respond('decline')
      })
      var payBtn = document.getElementById('paydeposit')
      if (payBtn) payBtn.addEventListener('click', function () {
        payBtn.disabled = true
        payBtn.textContent = 'Opening secure payment…'
        post(API + '/v1/public/payments/session', { slug: slug, kind: 'quote_deposit', token: token })
          .then(function (r) {
            if (r.status === 200 && r.data.url) { location.href = r.data.url; return }
            payBtn.disabled = false
            payBtn.textContent = 'Try again'
            document.getElementById('pay-err').textContent =
              (r.data && r.data.message) || 'Payment could not be started. Try again.'
          })
      })
    }).catch(function () { fail('This quote could not be loaded right now.') })
  }

  // ── Review ─────────────────────────────────────────────────────────────

  function reviewPage() {
    if (!token) return fail('This link is not valid.')
    var qs = '?slug=' + encodeURIComponent(slug) + '&token=' + encodeURIComponent(token)
    get(API + '/v1/public/reviews/invite' + qs).then(function (res) {
      if (res.status !== 200) return fail('This review link could not be found. It may have expired.')
      var info = res.data
      document.title = 'How did we do? — ' + (info.business || '')
      app.className = ''
      var foot = '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

      if (info.responded) {
        app.innerHTML =
          '<header><div class="name">' + esc(info.business || '') + '</div></header>' +
          '<div class="page-body"><div class="done">' +
          '<div class="tick">&#10003;</div><h2>Thank you</h2>' +
          '<p class="hint">This review has already been received.</p>' +
          '</div>' + foot
        return
      }

      var rating = 0
      app.innerHTML =
        '<header><div class="name">' + esc(info.business || '') + '</div></header>' +
        '<div class="page-body">' +
        '<h2 class="q-title">How did we do' + (info.name ? ', ' + esc(info.name) : '') + '?</h2>' +
        (info.serviceName ? '<p class="lead">Your ' + esc(info.serviceName) + ' with ' + esc(info.business || 'us') + '.</p>' : '') +
        '<div class="stars" id="stars">' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<button class="star" data-n="' + n + '" aria-label="' + n + ' star' + (n > 1 ? 's' : '') + '">&#9734;</button>'
        }).join('') +
        '</div>' +
        '<form id="rform" class="pform">' +
        '<label>A few words, if you have a minute (optional)</label>' +
        '<textarea id="f-text" rows="4" maxlength="1500"></textarea>' +
        '<button class="primary" type="submit" id="submit" disabled>Send review</button>' +
        '<p class="form-err" id="f-err"></p>' +
        '</form>' + foot

      function paint() {
        app.querySelectorAll('.star').forEach(function (b) {
          var n = Number(b.getAttribute('data-n'))
          b.innerHTML = n <= rating ? '&#9733;' : '&#9734;'
          b.className = 'star' + (n <= rating ? ' on' : '')
        })
        document.getElementById('submit').disabled = rating === 0
      }
      app.querySelectorAll('.star').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.preventDefault()
          rating = Number(b.getAttribute('data-n'))
          paint()
        })
      })

      app.querySelector('#rform').addEventListener('submit', function (e) {
        e.preventDefault()
        if (!rating) return
        var err = document.getElementById('f-err')
        err.textContent = ''
        var btn = document.getElementById('submit')
        btn.disabled = true
        btn.textContent = 'Sending…'
        post(API + '/v1/public/reviews/respond' + qs, {
          slug: slug, token: token, rating: rating,
          text: document.getElementById('f-text').value.trim(),
        }).then(function (r) {
          if (r.status !== 200) {
            btn.disabled = false
            btn.textContent = 'Send review'
            err.textContent = (r.data && r.data.message) || 'That did not work. Try again.'
            return
          }
          app.querySelector('.page-body').innerHTML =
            '<div class="done">' +
            '<div class="tick">&#10003;</div><h2>Thank you</h2>' +
            '<p class="hint">Your review means a lot to a small business.</p>' +
            (r.data.googleLink
              ? '<p>Happy to say it publicly? <a class="primary-link" href="' + esc(r.data.googleLink) + '" target="_blank" rel="noopener">Leave a Google review too</a></p>'
              : '') +
            '</div>'
        })
      })
    }).catch(function () { fail('This review link could not be loaded right now.') })
  }

  // ── Invoice ────────────────────────────────────────────────────────────

  function invoicePage() {
    if (!token) return fail('This link is not valid.')
    get(API + '/v1/public/quotes/invoice?slug=' + encodeURIComponent(slug) + '&token=' + encodeURIComponent(token))
      .then(function (res) {
        if (res.status !== 200) return fail('This invoice could not be found.')
        var inv = res.data.invoice
        var business = res.data.business || ''
        var theme = res.data.theme || 'classic'
        document.title = inv.label + ' — ' + business
        app.className = ''
        document.body.classList.add('invoice-' + theme)

        var style = document.createElement('style')
        style.textContent =
          '.inv{max-width:640px;margin:0 auto}' +
          '.inv table{width:100%;border-collapse:collapse;margin:1rem 0}' +
          '.inv td,.inv th{padding:.5rem .25rem;text-align:left;vertical-align:top}' +
          '.inv .num{text-align:right;white-space:nowrap}' +
          '.inv .i-unit{display:block;font-size:.85em;opacity:.65}' +
          '.inv .i-total td{font-weight:700;border-top:2px solid currentColor}' +
          '.inv .i-meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}' +
          '.inv .i-paid{display:inline-block;padding:.2rem .6rem;border-radius:4px;font-weight:700}' +
          '.inv .i-pay{white-space:pre-wrap;padding:.75rem;border-radius:6px;margin-top:1rem}' +
          '.inv .i-print{margin-top:1.25rem}' +
          '@media print{header,footer,.i-print{display:none!important}body{background:#fff}}' +
          // classic: serif headings, ruled lines, quiet.
          (theme === 'classic'
            ? '.inv h2{font-family:Georgia,serif;font-weight:400;letter-spacing:.02em}' +
              '.inv tbody tr{border-bottom:1px solid rgba(128,128,128,.25)}' +
              '.inv .i-paid{background:#e8f5e9;color:#1b5e20}.inv .i-pay{background:rgba(128,128,128,.08)}'
            : '') +
          // compact: small, dense, tabular - for the inbox skim-reader.
          (theme === 'compact'
            ? '.inv{font-size:.92em}.inv h2{font-size:1.15em;text-transform:uppercase;letter-spacing:.08em}' +
              '.inv td,.inv th{padding:.3rem .25rem}.inv thead th{border-bottom:1px solid currentColor;font-size:.8em;text-transform:uppercase}' +
              '.inv .i-paid{background:#e8f5e9;color:#1b5e20}.inv .i-pay{border:1px solid rgba(128,128,128,.3)}'
            : '') +
          // bold: heavy header band, big total - reads at arm's length.
          (theme === 'bold'
            ? '.inv h2{font-size:1.6em;font-weight:800}' +
              '.inv .i-band{background:var(--brand,#111);color:var(--brand-fg,#fff);padding:1rem;border-radius:8px;margin-bottom:1rem}' +
              '.inv .i-band h2{margin:0}.inv .i-band p{margin:.25rem 0 0;opacity:.8}' +
              '.inv .i-total td{font-size:1.25em}' +
              '.inv .i-paid{background:#1b5e20;color:#fff}.inv .i-pay{background:rgba(128,128,128,.12)}'
            : '')
        document.head.appendChild(style)

        var dateOf = function (iso) {
          return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
        }
        var lines = inv.lines.map(function (l) {
          return '<tr><td>' + esc(l.description) +
            '<span class="i-unit">' + l.quantity + ' ' + esc(l.unit) + ' × ' + money(l.unitCents, inv.currency) + '</span></td>' +
            '<td class="num">' + money(l.totalCents, inv.currency) + '</td></tr>'
        }).join('')

        var heading = theme === 'bold'
          ? '<div class="i-band"><h2>' + esc(inv.label) + '</h2><p>' + esc(business) + '</p></div>'
          : '<h2>' + esc(inv.label) + '</h2>'

        var iLogo = res.data.logoUrl
          ? '<img class="doc-logo" src="' + esc(res.data.logoUrl) + '" alt="" />'
          : ''
        app.innerHTML =
          '<header>' + iLogo + '<div class="name">' + esc(business) + '</div></header>' +
          '<div class="page-body"><div class="inv">' +
          heading +
          '<div class="i-meta">' +
          '<span>' + (inv.customerName ? 'Billed to ' + esc(inv.customerName) : '') + '</span>' +
          (inv.paidAt
            ? '<span class="i-paid">Paid ' + esc(dateOf(inv.paidAt)) + '</span>'
            : '<span>Issued ' + esc(dateOf(inv.issuedAt)) + ' · Due ' + esc(dateOf(inv.dueAt)) + '</span>') +
          '</div>' +
          '<table>' + (theme === 'compact' ? '<thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>' : '') +
          '<tbody>' + lines + '</tbody>' +
          '<tfoot>' +
          '<tr><td>Subtotal</td><td class="num">' + money(inv.subtotalCents, inv.currency) + '</td></tr>' +
          (inv.taxCents > 0 ? '<tr><td>' + esc(inv.taxLabel || 'Tax') + '</td><td class="num">' + money(inv.taxCents, inv.currency) + '</td></tr>' : '') +
          '<tr class="i-total"><td>Total' + (inv.paidAt ? ' (paid)' : ' due') + '</td><td class="num">' + money(inv.totalCents, inv.currency) + '</td></tr>' +
          '</tfoot></table>' +
          (inv.notes ? '<p class="q-notes">' + esc(inv.notes) + '</p>' : '') +
          (res.data.payable
            ? '<p class="i-print"><button class="primary" id="paynow">Pay ' + money(inv.totalCents, inv.currency) + ' online</button></p>' +
              '<p class="hint">Secure card payment via Stripe, straight to ' + esc(business) + '. This page shows Paid once the payment lands.</p>' +
              '<p class="form-err" id="pay-err"></p>'
            : '') +
          (inv.paymentInstructions && !inv.paidAt ? '<div class="i-pay">' + esc(inv.paymentInstructions) + '</div>' : '') +
          '<p class="i-print"><button class="ghost" id="print">Print or save as PDF</button></p>' +
          (res.data.footer ? '<p class="doc-footer">' + esc(res.data.footer) + '</p>' : '') +
          '</div></div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

        if (params.get('paid') === 'pending' && !inv.paidAt) {
          var note = document.createElement('p')
          note.className = 'q-state ok'
          note.textContent = 'Payment received - this page will show Paid once the bank confirms, usually within a minute.'
          app.querySelector('.inv').insertBefore(note, app.querySelector('.inv').firstChild)
        }
        var payNow = document.getElementById('paynow')
        if (payNow) payNow.addEventListener('click', function () {
          payNow.disabled = true
          payNow.textContent = 'Opening secure payment…'
          post(API + '/v1/public/payments/session', { slug: slug, kind: 'invoice', token: token })
            .then(function (r) {
              if (r.status === 200 && r.data.url) { location.href = r.data.url; return }
              payNow.disabled = false
              payNow.textContent = 'Try again'
              document.getElementById('pay-err').textContent =
                (r.data && r.data.message) || 'Payment could not be started. Try again.'
            })
        })

        document.getElementById('print').addEventListener('click', function () { window.print() })
      })
      .catch(function () { fail('This invoice could not be loaded right now.') })
  }
})()

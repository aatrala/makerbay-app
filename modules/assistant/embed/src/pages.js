/**
 * Customer-facing pages on the chat surface, beyond the chat itself:
 *   /booking?slug=...             pick a service, a day and a real free slot
 *   /booking/cancel?slug=&token=  view or cancel a booking, no account needed
 *   /quote?slug=&token=           view a quote and accept or decline it
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

  if (path === '/booking') return bookingPage()
  if (path === '/booking/cancel') return cancelPage()
  if (path === '/quote') return quotePage()
  return fail('This link is not valid.')

  // ── Booking ────────────────────────────────────────────────────────────

  function bookingPage() {
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
                '<span class="c-meta">' + (s.priceCents != null ? money(s.priceCents) + ' · ' : '') + s.durationMinutes + ' min</span>' +
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
          app.innerHTML = head('Nearly done — how do we reach you?') +
            '<form id="bform" class="pform">' +
            '<label>Your name</label><input id="f-name" autocomplete="name" />' +
            '<label>Email</label><input id="f-email" type="email" autocomplete="email" />' +
            '<label>Phone</label><input id="f-phone" type="tel" autocomplete="tel" />' +
            '<label>Anything we should know? (optional)</label><textarea id="f-note" rows="2"></textarea>' +
            '<p class="hint">Email or phone — whichever suits. The confirmation goes there.</p>' +
            '<button class="primary" type="submit">Confirm booking</button>' +
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

        stepService()
      })
      .catch(function () { fail('Online booking is not available right now.') })
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
      document.title = 'Quote #' + q.number + ' — ' + business
      app.className = ''
      var foot = '</div><footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

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
        stateBlock = '<p class="q-state ok">Accepted' + (q.customerName ? ' by ' + esc(q.customerName) : '') + '. ' +
          esc(business) + ' has been told and will be in touch.</p>'
      } else if (q.status === 'declined') {
        stateBlock = '<p class="q-state">This quote was declined.</p>'
      } else if (q.status === 'expired') {
        stateBlock = '<p class="q-state">This quote expired on ' + esc(validUntil) + '. Ask ' + esc(business) + ' for an updated one.</p>'
      } else {
        stateBlock =
          '<div class="q-actions">' +
          '<button class="primary" id="accept">Accept this quote</button>' +
          '<button class="ghost" id="decline">Decline</button>' +
          '</div>' +
          '<p class="hint">Valid until ' + esc(validUntil) + '. Accepting tells ' + esc(business) + ' to go ahead.</p>' +
          '<p class="form-err" id="f-err"></p>'
      }

      app.innerHTML =
        '<header><div class="name">' + esc(business) + '</div></header>' +
        '<div class="page-body">' +
        '<h2 class="q-title">Quote #' + q.number + (q.customerName ? ' for ' + esc(q.customerName) : '') + '</h2>' +
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
    }).catch(function () { fail('This quote could not be loaded right now.') })
  }
})()

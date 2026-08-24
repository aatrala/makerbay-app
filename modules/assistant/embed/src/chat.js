/**
 * MakerBay chat surface. Serves two modes from one file:
 *   /embed?key=mb_pk_...   — inside the widget iframe
 *   /{workspace-slug}      — the hosted page
 */
;(function () {
  // Booking, cancellation and quote pages share this surface but not this
  // file. Dispatch before anything chat-shaped happens.
  var pagePath = location.pathname.replace(/\/+$/, '')
  if (pagePath === '/booking' || pagePath === '/booking/cancel' || pagePath === '/quote') {
    var s = document.createElement('script')
    s.src = '/pages.js'
    document.body.appendChild(s)
    return
  }

  var API = 'https://api.makerbay.app'
  var STREAM = 'https://stream.makerbay.app'
  var app = document.getElementById('app')
  var params = new URLSearchParams(location.search)
  var key = params.get('key')
  var slug = params.get('slug')
  var embedded = location.pathname.replace(/\/$/, '') === '/embed'

  if (!key && !slug) {
    // Hosted page: the workspace slug is the path.
    slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''))
  }
  if (!key && !slug) return fail('This chat link is not valid.')
  if (!embedded) document.body.classList.add('hosted')

  var query = key ? 'key=' + encodeURIComponent(key) : 'slug=' + encodeURIComponent(slug)
  var sessionId = null
  var config = null
  var busy = false

  function fail(message) {
    app.className = 'error'
    app.textContent = message
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function identify(payload) {
    if (key) payload.key = key
    else payload.slug = slug
    return payload
  }

  fetch(API + '/v1/public/assistant/config?' + query)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status) })
    .then(function (data) { config = data.assistant; render() })
    .catch(function () { fail('This assistant is unavailable right now.') })

  function render() {
    document.documentElement.style.setProperty('--brand', config.brandColor || '#0f6bff')
    document.title = config.name || 'Chat'
    app.className = ''
    app.innerHTML =
      '<header>' +
      '<div class="avatar">' + esc((config.name || 'A').trim().charAt(0).toUpperCase()) + '</div>' +
      '<div class="name">' + esc(config.name || 'Assistant') + '</div>' +
      '<button class="close" aria-label="Close chat">&#10005;</button>' +
      '</header>' +
      '<div class="log" id="log"></div>' +
      '<form id="form">' +
      '<input id="input" placeholder="Type your question…" autocomplete="off" />' +
      '<button class="send" id="send" type="submit">Send</button>' +
      '</form>' +
      '<footer>Powered by <a href="https://makerbay.app" target="_blank" rel="noopener">MakerBay</a></footer>'

    app.querySelector('.close').addEventListener('click', function () {
      parent.postMessage('makerbay:close', '*')
    })
    app.querySelector('#form').addEventListener('submit', send)
    if (config.greeting) add('bot', config.greeting)
    if (!embedded) app.querySelector('#input').focus()
  }

  /** Create a message bubble. Text is set via textContent, never innerHTML. */
  function add(role, text) {
    var log = document.getElementById('log')
    var el = document.createElement('div')
    el.className = 'msg ' + (role === 'me' ? 'me' : 'bot')
    var body = document.createElement('span')
    body.className = 'body'
    body.textContent = text || ''
    el.appendChild(body)
    log.appendChild(el)
    log.scrollTop = log.scrollHeight
    return el
  }

  function appendText(bubble, text) {
    bubble.querySelector('.body').textContent += text
    var log = document.getElementById('log')
    log.scrollTop = log.scrollHeight
  }

  /** Attach sources and the thumbs control once an answer is complete. */
  function decorate(bubble, sources, messageId) {
    if (sources && sources.length) {
      var src = document.createElement('div')
      src.className = 'src'
      src.textContent = 'Sources: ' + sources.map(function (s) { return s.name }).join(', ')
      bubble.appendChild(src)
    }
    if (!messageId) return

    var rate = document.createElement('div')
    rate.className = 'src rate'
    rate.innerHTML =
      'Was this helpful? <button type="button" data-v="up" aria-label="Helpful">&#128077;</button>' +
      ' <button type="button" data-v="down" aria-label="Not helpful">&#128078;</button>'
    rate.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-v')
      if (!v) return
      rate.textContent = 'Thanks for the feedback.'
      fetch(API + '/v1/public/assistant/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identify({ sessionId: sessionId, messageId: messageId, feedback: v })),
      }).catch(function () {})
    })
    bubble.appendChild(rate)
  }

  function send(e) {
    e.preventDefault()
    var input = document.getElementById('input')
    var message = input.value.trim()
    if (!message || busy) return
    input.value = ''
    add('me', message)
    busy = true
    document.getElementById('send').disabled = true

    var log = document.getElementById('log')
    var typing = document.createElement('div')
    typing.className = 'typing'
    typing.textContent = 'Typing…'
    log.appendChild(typing)
    log.scrollTop = log.scrollHeight

    var payload = identify({ message: message, sessionId: sessionId || undefined })
    var bubble = null
    var messageId = null
    var limitHit = false

    function finish() {
      busy = false
      document.getElementById('send').disabled = false
      document.getElementById('input').focus()
    }

    function ensureBubble() {
      if (bubble) return
      if (typing.parentNode) typing.remove()
      bubble = add('bot', '')
    }

    // Stream tokens as they arrive. If streaming is unavailable — an older
    // browser, a proxy that buffers, a network error before any token lands —
    // fall back to the single-response route so the answer still appears.
    fetch(STREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (!r.ok || !r.body || !r.body.getReader) throw new Error('no_stream')
        var reader = r.body.getReader()
        var decoder = new TextDecoder()
        var buf = ''

        function handle(line) {
          if (!line.trim()) return
          var evt
          try { evt = JSON.parse(line) } catch (err) { return }
          if (evt.type === 'meta') {
            sessionId = evt.sessionId
            messageId = evt.messageId
          } else if (evt.type === 'delta') {
            ensureBubble()
            appendText(bubble, evt.text)
          } else if (evt.type === 'done') {
            ensureBubble()
            decorate(bubble, evt.citations, evt.messageId || messageId)
          } else if (evt.type === 'error') {
            if (evt.error === 'limit_exceeded') limitHit = true
            throw new Error(evt.error)
          }
        }

        function pump() {
          return reader.read().then(function (res) {
            if (res.done) {
              if (buf.trim()) handle(buf)
              return
            }
            buf += decoder.decode(res.value, { stream: true })
            var lines = buf.split('\n')
            buf = lines.pop()
            lines.forEach(handle)
            return pump()
          })
        }
        return pump()
      })
      .catch(function () {
        // A partial answer is already on screen; leave it rather than duplicate.
        if (bubble) return
        if (typing.parentNode) typing.remove()
        if (limitHit) {
          add('bot', 'This assistant has reached its message limit for the month.')
          return
        }
        return fetch(API + '/v1/public/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d } }) })
          .then(function (res) {
            if (res.status === 200) {
              sessionId = res.data.sessionId
              var el = add('bot', res.data.answer)
              decorate(el, res.data.citations, res.data.messageId)
            } else if (res.status === 429) {
              add('bot', 'This assistant has reached its message limit for the month.')
            } else {
              add('bot', 'Sorry, something went wrong. Please try again.')
            }
          })
          .catch(function () { add('bot', 'Sorry, something went wrong. Please try again.') })
      })
      .then(finish, finish)
  }
})()

/**
 * MakerBay chat surface. Serves two modes from one file:
 *   /embed?key=mb_pk_...   — inside the widget iframe
 *   /{workspace-slug}      — the hosted page
 */
;(function () {
  var API = 'https://api.makerbay.app'
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

  function add(role, text, sources) {
    var log = document.getElementById('log')
    var el = document.createElement('div')
    el.className = 'msg ' + (role === 'me' ? 'me' : 'bot')
    el.innerHTML =
      esc(text) +
      (sources && sources.length
        ? '<div class="src">Sources: ' + esc(sources.map(function (s) { return s.name }).join(', ')) + '</div>'
        : '')
    log.appendChild(el)
    log.scrollTop = log.scrollHeight
    return el
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

    var typing = document.createElement('div')
    typing.className = 'typing'
    typing.textContent = 'Typing…'
    var log = document.getElementById('log')
    log.appendChild(typing)
    log.scrollTop = log.scrollHeight

    var payload = { message: message, sessionId: sessionId || undefined }
    if (key) payload.key = key
    else payload.slug = slug

    fetch(API + '/v1/public/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d } }) })
      .then(function (res) {
        typing.remove()
        if (res.status === 200) {
          sessionId = res.data.sessionId
          add('bot', res.data.answer, res.data.citations)
        } else if (res.status === 429) {
          add('bot', 'This assistant has reached its message limit for the month.')
        } else {
          add('bot', 'Sorry, something went wrong. Please try again.')
        }
      })
      .catch(function () {
        typing.remove()
        add('bot', 'Sorry, something went wrong. Please try again.')
      })
      .then(function () {
        busy = false
        document.getElementById('send').disabled = false
        document.getElementById('input').focus()
      })
  }
})()

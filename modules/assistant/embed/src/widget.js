/**
 * MakerBay chat widget loader.
 *
 * Usage on any website:
 *   <script src="https://widget.makerbay.app/widget.js" data-key="mb_pk_..."></script>
 *
 * The chat UI runs inside a cross-origin iframe, so it cannot read or alter
 * the host page, and the host page cannot read the conversation.
 */
;(function () {
  var script = document.currentScript
  if (!script) return
  var key = script.getAttribute('data-key')
  var slug = script.getAttribute('data-slug')
  if (!key && !slug) return console.error('[makerbay] widget needs data-key or data-slug')

  var ORIGIN = script.src.replace(/\/widget\.js.*$/, '').replace('//widget.', '//chat.')
  var color = script.getAttribute('data-color') || '#0f6bff'
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right'
  var open = false

  var bubble = document.createElement('button')
  bubble.setAttribute('aria-label', 'Open chat')
  bubble.style.cssText = [
    'position:fixed', 'bottom:20px', side + ':20px', 'width:56px', 'height:56px',
    'border-radius:50%', 'border:none', 'cursor:pointer', 'z-index:2147483000',
    'background:' + color, 'color:#fff', 'font-size:24px', 'line-height:1',
    'box-shadow:0 4px 16px rgba(0,0,0,.24)', 'display:flex',
    'align-items:center', 'justify-content:center', 'padding:0',
    'transition:transform .15s ease',
  ].join(';')
  bubble.innerHTML = '&#128172;'
  bubble.onmouseenter = function () { bubble.style.transform = 'scale(1.06)' }
  bubble.onmouseleave = function () { bubble.style.transform = 'scale(1)' }

  var frame = document.createElement('iframe')
  frame.title = 'Chat'
  frame.src = ORIGIN + '/embed?' + (key ? 'key=' + encodeURIComponent(key) : 'slug=' + encodeURIComponent(slug))
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin')
  frame.style.cssText = [
    'position:fixed', 'bottom:88px', side + ':20px', 'width:380px', 'height:min(560px,70vh)',
    'max-width:calc(100vw - 40px)', 'border:none', 'border-radius:14px', 'z-index:2147483000',
    'box-shadow:0 10px 40px rgba(0,0,0,.22)', 'display:none', 'background:#fff',
  ].join(';')

  function toggle() {
    open = !open
    frame.style.display = open ? 'block' : 'none'
    bubble.innerHTML = open ? '&#10005;' : '&#128172;'
    bubble.setAttribute('aria-label', open ? 'Close chat' : 'Open chat')
  }
  bubble.onclick = toggle

  // The iframe asks to be closed when the visitor taps its header control.
  window.addEventListener('message', function (e) {
    if (e.origin === ORIGIN && e.data === 'makerbay:close' && open) toggle()
  })

  function mount() {
    document.body.appendChild(frame)
    document.body.appendChild(bubble)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()

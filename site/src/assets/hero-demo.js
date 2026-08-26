/**
 * The living hero demo (issue 84). The conversation is real HTML, visible by
 * default (no-JS = a good still frame). With JS: hide, then replay once with
 * typing dots when the frame scrolls into view; a tap swaps the staged DOM
 * for the real hosted chat in an iframe. No dependencies, no loops - a
 * looping demo reads as a GIF.
 */
;(function () {
  var phone = document.querySelector('.hero-demo .phone')
  if (!phone) return
  var body = phone.querySelector('.phone-body')
  var live = phone.querySelector('.phone-live')
  var bubbles = Array.prototype.slice.call(phone.querySelectorAll('.hb'))
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function play() {
    if (reduced || bubbles.length === 0) return
    phone.classList.add('playing')
    var i = 0
    var dots = document.createElement('div')
    dots.className = 'typing-dots'
    dots.textContent = '•••'
    function next() {
      var prev = phone.querySelector('.typing-dots')
      if (prev) prev.remove()
      if (i >= bubbles.length) return
      var b = bubbles[i++]
      b.classList.add('shown')
      var moreComing = i < bubbles.length
      if (moreComing) {
        setTimeout(function () {
          body.appendChild(dots)
          setTimeout(next, 700)
        }, 500)
      }
    }
    setTimeout(next, 400)
  }

  if ('IntersectionObserver' in window) {
    var seen = false
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && !seen) {
          seen = true
          io.disconnect()
          play()
        }
      })
    }, { threshold: 0.5 })
    io.observe(phone)
  }

  if (live) {
    live.addEventListener('click', function () {
      var url = phone.getAttribute('data-live')
      if (!url) return
      live.textContent = 'Loading the real thing…'
      live.disabled = true
      var frame = document.createElement('iframe')
      frame.title = 'Try the MakerBay assistant'
      frame.src = url
      frame.addEventListener('load', function () {
        bubbles.forEach(function (b) { b.remove() })
        var d = phone.querySelector('.typing-dots')
        if (d) d.remove()
        live.remove()
      })
      frame.addEventListener('error', function () {
        window.open(url, '_blank', 'noopener')
        live.textContent = "It's real — tap to ask your own question"
        live.disabled = false
      })
      body.appendChild(frame)
    })
  }
})()

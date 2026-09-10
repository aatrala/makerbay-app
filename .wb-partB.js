// MakerBay visual E2E — Part B: chat/booking surface end-to-end.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'partB-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(action, args = {}) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: S }),
  });
  return res.json();
}
async function shot(name) {
  const r = await post('screenshot', { format: 'jpeg', quality: 70, path: path.join(SHOTS, name) });
  log.push({ step: name, ok: !!r.ok, bytes: r.data?.sizeBytes ?? null, err: r.error || null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error || null });
  return r.ok ? r.data.value : null;
}
async function nav(name, url, waitMs = 4000) {
  const r = await post('navigate', { url, newTab: true });
  log.push({ step: 'nav:' + name, ok: !!r.ok, url, err: r.error || null });
  await sleep(waitMs);
}

(async () => {
  try {
    // Get the embed URL from the demo page's iframe
    await post('find_tab', { url: 'https://demo.makerbay.app' });
    await sleep(1000);
    const src = await ev('demo:iframe-src', "(()=>{const f=document.querySelector('iframe'); return f?f.src:'none'})()");
    const chatUrl = (src && src !== 'none') ? src : 'https://chat.makerbay.app/embed?slug=southside-plumbing';

    await nav('chat-surface', chatUrl, 5000);
    await shot('chat-1-open.jpg');

    // Ask a real question
    await ev('chat:type', "(()=>{const i=document.querySelector('input,textarea'); if(!i) return 'noinput'; i.focus(); return 'focused'})()");
    await post('fill', { selector: 'input, textarea', value: 'How much is a leak inspection and do you cover Marrickville?' });
    await sleep(500);
    await ev('chat:send', "(()=>{const b=[...document.querySelectorAll('button')].find(e=>/^send$/i.test(e.textContent.trim())); if(!b) return 'nosend'; b.click(); return 'sent'})()");
    await sleep(9000);
    await shot('chat-2-answer.jpg');

    // Booking flow inside the chat surface
    await ev('chat:book-chip', "(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>/book a time/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(2000);
    await shot('chat-3-book.jpg');
    await ev('chat:service', "(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>/leak inspection/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(2500);
    await shot('chat-4-daylist.jpg');
    // pick first day button (short label with a digit)
    const day = await ev('chat:day', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length<22&&/\\d/.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2000);
    await shot('chat-5-times.jpg');
    // pick first time button (contains : or am/pm)
    await ev('chat:time', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&/(:|am|pm)/i.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2000);
    await shot('chat-6-details.jpg');
    // fill details form if present
    await ev('chat:fill-details', "(()=>{const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent); const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; d.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; let filled=[]; for(const i of ins){ const id=(i.name+i.id+i.placeholder+i.type).toLowerCase(); if(/name/.test(id)&&!/first|last/.test(id)){set(i,'E2E Test');filled.push('name')} else if(/email/.test(id)){set(i,'aatrala+b2@gmail.com');filled.push('email')} else if(/phone|tel/.test(id)){set(i,'0400000000');filled.push('phone')} else if(/address/.test(id)){set(i,'1 Test St, Newtown');filled.push('address')} } return JSON.stringify(filled)})()");
    await sleep(600);
    await shot('chat-7-filled.jpg');
    // submit booking
    await ev('chat:confirm', "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent&&/confirm|book|request|done/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,30)})()");
    await sleep(3500);
    await shot('chat-8-confirmation.jpg');

    log.push({ step: 'DONE', ok: true });
  } catch (e) {
    log.push({ step: 'FATAL', ok: false, err: String(e) });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();

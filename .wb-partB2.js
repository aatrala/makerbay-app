// MakerBay visual E2E — Part B2: Southside demo chat + booking; makerbay-hq booking to deposit step.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'partB2-log.json');
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
async function nav(name, url, waitMs = 4500) {
  const r = await post('navigate', { url });
  log.push({ step: 'nav:' + name, ok: !!r.ok, url, err: r.error || null });
  await sleep(waitMs);
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,40)})()`;

(async () => {
  try {
    // 1. Find Southside's real embed URL from the demo page
    await nav('demo-page', 'https://demo.makerbay.app', 5000);
    const src = await ev('demo:iframe-src', "(()=>{const f=[...document.querySelectorAll('iframe')].map(i=>i.src).find(s=>/chat\\./.test(s)); return f||'none'})()");

    // 2. Southside chat: grounded Q&A
    if (src && src !== 'none') {
      await nav('ss-chat', src, 5000);
      await post('fill', { selector: 'input, textarea', value: 'How much is a leak inspection and do you cover Marrickville?' });
      await sleep(400);
      await ev('ss:send', clickByText('/^send$/i'));
      await sleep(10000);
      await shot('ss-1-answer.jpg');

      // 3. Southside booking flow
      await ev('ss:book', clickByText('/book a time/i'));
      await sleep(3000);
      await shot('ss-2-booking.jpg');
      await ev('ss:service', clickByText('/leak inspection/i'));
      await sleep(3000);
      await shot('ss-3-days.jpg');
      await ev('ss:day', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length<24&&/\\d/.test(e.textContent)&&!/^\\D*$/.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
      await sleep(2500);
      await shot('ss-4-times.jpg');
      await ev('ss:time', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&/(:\\d|am|pm)/i.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
      await sleep(2500);
      await shot('ss-5-details.jpg');
      await ev('ss:fill', "(()=>{const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent); const proto=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const set=(el,v)=>{proto.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; const out=[]; for(const i of ins){const id=(i.name+' '+i.id+' '+i.placeholder+' '+i.type).toLowerCase(); if(/email/.test(id)){set(i,'aatrala+b2@gmail.com');out.push('email')} else if(/phone|tel/.test(id)){set(i,'0400000000');out.push('phone')} else if(/address/.test(id)){set(i,'1 Test St, Newtown');out.push('address')} else if(/name|your/.test(id)){set(i,'E2E Test');out.push('name')}} return JSON.stringify(out)})()");
      await sleep(500);
      await shot('ss-6-filled.jpg');
      await ev('ss:confirm', clickByText('/confirm|request booking|book now|done/i'));
      await sleep(4000);
      await shot('ss-7-confirmation.jpg');
    }

    // 4. makerbay-hq booking up to (not through) the deposit step
    await nav('hq-book', 'https://chat.makerbay.app/embed?slug=makerbay-hq', 5000);
    await ev('hq:book', clickByText('/book a time/i'));
    await sleep(3000);
    await ev('hq:service', clickByText('/setup session/i'));
    await sleep(3000);
    await shot('hq-1-days.jpg');
    await ev('hq:day', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length<24&&/\\d/.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2500);
    await shot('hq-2-times.jpg');
    await ev('hq:time', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&/(:\\d|am|pm)/i.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2500);
    await shot('hq-3-deposit-step.jpg');
    log.push({ step: 'hq:STOP-before-payment', ok: true, value: 'deposit/payment step reached visually; not executed by design' });

    log.push({ step: 'DONE', ok: true });
  } catch (e) {
    log.push({ step: 'FATAL', ok: false, err: String(e) });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();

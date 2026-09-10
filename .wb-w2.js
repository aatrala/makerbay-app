// Workflow pass W2: create a service (write), then book it as a customer end-to-end.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'w2-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(action, args = {}) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: S }),
  });
  return res.json();
}
async function shot(name) {
  const r = await post('screenshot', { format: 'jpeg', quality: 70, path: path.join(SHOTS, name) });
  log.push({ step: name, ok: !!r.ok, err: r.error || null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error || null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,40)})()`;

(async () => {
  try {
    // 1. Create the service
    await post('navigate', { url: 'https://app.makerbay.app/booking/services' });
    await sleep(5000);
    await post('fill', { selector: '#s-name', value: 'E2E Test Service' });
    await post('fill', { selector: '#s-dur', value: '30' });
    await post('fill', { selector: '#s-buf', value: '15' });
    await post('fill', { selector: '#s-price', value: '120' });
    await sleep(300);
    await shot('w2-1-form-filled.jpg');
    await ev('svc:add', clickByText('/add service/i'));
    await sleep(4000);
    await shot('w2-2-after-add.jpg');
    await ev('svc:list', "(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length&&/what you offer/i.test(e.textContent||'')); return document.body.innerText.slice(0,700)})()");

    // 2. Book it as a customer on the public booking page
    await post('navigate', { url: 'https://chat.makerbay.app/booking?slug=test-page' });
    await sleep(5000);
    await shot('w2-3-booking-page.jpg');
    await ev('bk:service', clickByText('/E2E Test Service/i'));
    await sleep(3000);
    await shot('w2-4-days.jpg');
    await ev('bk:day', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length<26&&/\\d/.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2500);
    await shot('w2-5-times.jpg');
    await ev('bk:time', "(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&/(:\\d|am|pm)/i.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()");
    await sleep(2500);
    await shot('w2-6-details.jpg');
    await ev('bk:fill', "(()=>{const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent); const proto=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const set=(el,v)=>{proto.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; const out=[]; for(const i of ins){const id=(i.name+' '+i.id+' '+i.placeholder+' '+i.type).toLowerCase(); if(/email/.test(id)){set(i,'aatrala+b2@gmail.com');out.push('email')} else if(/phone|tel/.test(id)){set(i,'0400000000');out.push('phone')} else if(/address/.test(id)){set(i,'2 Workflow Ave');out.push('address')} else if(/name|your/.test(id)){set(i,'E2E Workflow Customer');out.push('name')}} return JSON.stringify(out)})()");
    await sleep(500);
    await ev('bk:confirm', clickByText('/confirm|request|book|done/i'));
    await sleep(4500);
    await shot('w2-7-confirmation.jpg');
    await ev('bk:final', 'document.body.innerText.slice(0,400)');

    // 3. Verify it landed in the owner diary
    await post('navigate', { url: 'https://app.makerbay.app/booking/diary' });
    await sleep(5000);
    await shot('w2-8-diary.jpg');
    await ev('diary:text', 'document.body.innerText.slice(0,500)');

    log.push({ step: 'DONE', ok: true });
  } catch (e) { log.push({ step: 'FATAL', ok: false, err: String(e) }); }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();

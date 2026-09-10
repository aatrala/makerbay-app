// W2-retry (fixed): book "E2E Test Service" on slug=test-page as a customer, choosing a future
// weekday; verify Diary shows the booking; then create + remove a Block-out-time entry.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w2b-log.json');
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
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().replace(/\\s+/g,' ').slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,1200))()`;

(async () => {
  try {
    // 1. Public booking page — pick the service
    await post('navigate', { url: 'https://chat.makerbay.app/booking?slug=test-page' });
    await sleep(5000);
    await shot('w2b-1-booking.jpg');
    await ev('bk:service', clickByText('/E2E Test Service/i'));
    await sleep(3000);
    await shot('w2b-2-days.jpg');

    // 2. Dump visible day buttons, then click a FUTURE weekday (not Thursday 10 Sep)
    await ev('bk:daylist', `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(e=>e.offsetParent).map(b=>b.textContent.trim().replace(/\\s+/g,' ')).filter(t=>t&&t.length<40)))()`);
    await ev('bk:day', `(()=>{
      const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent);
      const b=bs.find(x=>/friday 11/i.test(x.textContent)) || bs.find(x=>/(monday|tuesday|wednesday|friday|saturday|sunday)/i.test(x.textContent)&&!/thursday 10/i.test(x.textContent));
      if(!b) return 'notfound'; b.click(); return b.textContent.trim().replace(/\\s+/g,' ').slice(0,60);
    })()`);
    await sleep(3000);
    await shot('w2b-3-times.jpg');
    const afterDay = await ev('bk:after-day', body());

    if (afterDay && /nothing free/i.test(afterDay)) {
      log.push({ step: 'RESULT', value: 'NO_SLOTS' });
      fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
      return;
    }

    // 3. Pick first time slot
    await ev('bk:time', `(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&/(:\\d|am|pm)/i.test(e.textContent)); if(!bs.length) return 'notfound'; bs[0].click(); return bs[0].textContent.trim()})()`);
    await sleep(2500);
    await shot('w2b-4-form.jpg');

    // 4. Fill customer details
    await ev('bk:fields', `(()=>JSON.stringify([...document.querySelectorAll('input,textarea')].filter(i=>i.offsetParent).map(i=>({id:i.id,name:i.name,ph:i.placeholder,type:i.type}))))()`);
    await ev('bk:fill', `(()=>{const ins=[...document.querySelectorAll('input,textarea')].filter(i=>i.offsetParent); const proto=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const set=(el,v)=>{proto.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; const out=[]; for(const i of ins){const id=(i.name+' '+i.id+' '+i.placeholder+' '+i.type).toLowerCase(); if(/email/.test(id)){set(i,'aatrala+b2@gmail.com');out.push('email')} else if(/phone|tel|mobile/.test(id)){set(i,'0400000000');out.push('phone')} else if(/note|message/.test(id)){set(i,'E2E workflow test booking');out.push('note')} else if(/name|your/.test(id)){set(i,'E2E Workflow Customer');out.push('name')}} return JSON.stringify(out)})()`);
    await sleep(500);
    await shot('w2b-5-filled.jpg');

    // 5. Confirm
    await ev('bk:confirm', clickByText('/confirm|request booking|book now|book/i'));
    await sleep(5000);
    await shot('w2b-6-confirmed.jpg');
    await ev('bk:after-confirm', body());

    // 6. Diary — booking visible?
    await post('navigate', { url: 'https://app.makerbay.app/diary' });
    await sleep(5000);
    await shot('w2b-7-diary.jpg');
    await ev('diary:text', body());

    // 7. Block out time — open dialog and inspect fields (create in follow-up if fields clear)
    await ev('block:open', clickByText('/block out/i'));
    await sleep(1500);
    await shot('w2b-8-block-dialog.jpg');
    await ev('block:fields', `(()=>JSON.stringify([...document.querySelectorAll('input,textarea,select')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,id:i.id,name:i.name,ph:i.placeholder}))))()`);

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

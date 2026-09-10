// W2d: check Requests queue for the new booking; create + verify + remove a diary block-out.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w2d-log.json');
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
  log.push({ step: name, ok: !!r.ok, err: r.error ? JSON.stringify(r.error).slice(0, 150) : null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().replace(/\\s+/g,' ').slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,1800))()`;

(async () => {
  try {
    // 1. Requests queue — is the booking pending there?
    await post('navigate', { url: 'https://app.makerbay.app/requests' });
    await sleep(4500);
    await ev('requests:text', body());
    await shot('w2d-1-requests.jpg');

    // 2. Reload diary fresh
    await post('navigate', { url: 'https://app.makerbay.app/booking/diary' });
    await sleep(4500);
    await ev('diary:text2', body());
    await shot('w2d-2-diary.jpg');

    // 3. Block out time: open dialog, fill, submit
    await ev('block:open', clickByText('/block out/i'));
    await sleep(1500);
    await ev('block:setdate', `(()=>{const d=document.querySelector('#blk-date'); if(!d) return 'nodate';
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(d,'2026-09-12'); d.dispatchEvent(new Event('input',{bubbles:true})); d.dispatchEvent(new Event('change',{bubbles:true}));
      const f=document.querySelector('#blk-from'), t=document.querySelector('#blk-to'), r=document.querySelector('#blk-reason');
      if(f){set.call(f,'09:00'); f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true}));}
      if(t){set.call(t,'12:00'); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true}));}
      if(r){set.call(r,'E2E test block'); r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true}));}
      return 'filled '+d.value})()`);
    await sleep(500);
    await shot('w2d-3-block-filled.jpg');
    await ev('block:submit', `(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent); const b=bs.find(x=>/^block$/i.test(x.textContent.trim())); if(!b) return 'nobtn'; b.click(); return 'clicked'})()`);
    await sleep(3000);
    await ev('diary:after-block', body());
    await shot('w2d-4-after-block.jpg');

    // 4. Remove the block (blocks are one-click removable)
    await ev('block:remove', `(()=>{const els=[...document.querySelectorAll('button,[role=button],a')].filter(e=>e.offsetParent); const b=els.find(e=>/remove|unblock|delete|✕|×/i.test(e.textContent.trim())); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,40)})()`);
    await sleep(2500);
    await ev('diary:after-remove', body());
    await shot('w2d-5-after-remove.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

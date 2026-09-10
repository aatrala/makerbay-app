// W2c: owner-side verification — Bookings/diary shows the new booking; block out time; contacts auto-created.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w2c-log.json');
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
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,1500))()`;

(async () => {
  try {
    // 1. Where does the "Bookings" nav go? Dump nav links first (we're on Home after redirect).
    await post('navigate', { url: 'https://app.makerbay.app/' });
    await sleep(4000);
    await ev('nav:links', `(()=>JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>({t:a.textContent.trim().replace(/\\s+/g,' ').slice(0,30),h:a.getAttribute('href')})).filter(x=>x.t)))()`);

    // 2. Go to Bookings
    await ev('nav:bookings', clickByText('/^bookings$/i'));
    await sleep(4000);
    await ev('bookings:url', `(()=>location.href)()`);
    await ev('bookings:text', body());
    await shot('w2c-1-bookings.jpg');

    // 3. Booking detail — click it if listed
    await ev('booking:open', clickByText('/E2E Workflow Customer/i'));
    await sleep(2500);
    await ev('booking:detail', body());
    await shot('w2c-2-booking-detail.jpg');

    // 4. Block out time
    await ev('block:open', clickByText('/block out/i'));
    await sleep(1500);
    await shot('w2c-3-block-dialog.jpg');
    await ev('block:fields', `(()=>JSON.stringify([...document.querySelectorAll('input,textarea,select')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,id:i.id,name:i.name,ph:i.placeholder}))))()`);
    await ev('block:buttons', `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim().replace(/\\s+/g,' ').slice(0,40))))()`);

    // 5. Contacts — auto-created?
    await ev('nav:contacts', clickByText('/^contacts$/i'));
    await sleep(4000);
    await ev('contacts:url', `(()=>location.href)()`);
    await ev('contacts:text', body());
    await shot('w2c-4-contacts.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

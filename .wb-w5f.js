// W5f: Genie — retry "What is booked this week?" now that the page is interactive.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w5f-log.json');
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
  log.push({ step: name, ok: !!r.ok });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  const v = r.data?.value ?? null;
  log.push({ step: name, ok: !!r.ok, value: typeof v === 'string' ? v.slice(0, 800) : v, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test((e.textContent||'').replace(/\\s+/g,' ').trim())); if(!b) return 'notfound'; b.click(); return (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(-1600))()`;

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/genie' });
    // wait until the input exists
    let ready = false;
    for (let i = 0; i < 8 && !ready; i++) {
      await sleep(3000);
      const v = await ev('g:wait' + i, `(()=>{const el=[...document.querySelectorAll('input,textarea')].find(i=>i.offsetParent); return el?'ready':'loading'})()`);
      ready = v === 'ready';
    }
    await ev('q1:type', `(()=>{
      const el=[...document.querySelectorAll('input,textarea')].find(i=>i.offsetParent);
      if(!el) return 'noinput';
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,'What is booked this week?');
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'typed';
    })()`);
    await sleep(400);
    await ev('q1:send', clickByText('/^ask$|^send$/i'));
    for (let i = 0; i < 8; i++) {
      await sleep(5000);
      const t = await ev('q1:poll' + i, body());
      if (t && /checked:|nothing booked|no bookings|booked/i.test(t)) break;
    }
    await shot('w5f-1-booked-week.jpg');
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

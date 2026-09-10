// W5d: robust save of knowledge source + playground verification (retry loops).
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w5d-log.json');
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
  log.push({ step: name, ok: !!r.ok, value: typeof v === 'string' ? v.slice(0, 500) : v, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test((e.textContent||'').replace(/\\s+/g,' ').trim())); if(!b) return 'notfound'; b.click(); return (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2400))()`;

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/assistant/knowledge' });
    await sleep(5000);

    // Click "Paste text" with retries (wait for hydration)
    let tab = 'notfound';
    for (let i = 0; i < 5 && tab === 'notfound'; i++) {
      tab = await ev('kn:tab' + i, clickByText('/^paste text$/i'));
      if (tab === 'notfound') await sleep(2000);
    }
    await sleep(1500);

    // Fill with retries
    let filled = 'missing';
    for (let i = 0; i < 4 && filled !== 'filled'; i++) {
      filled = await ev('kn:fill' + i, `(()=>{
        const n=document.querySelector('#k-name'), t=document.querySelector('#k-text');
        if(!n||!t||!n.offsetParent) return 'missing';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'E2E Workshop Policy');
        n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true}));
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Test page offers a 42-day satisfaction guarantee on all workshop bookings. If a customer is not happy within 42 days, we re-do the work free of charge. This policy was added for E2E testing.');
        t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true}));
        return 'filled';
      })()`);
      if (filled !== 'filled') await sleep(1500);
    }
    await shot('w5d-1-filled.jpg');

    // Save with retries
    let saved = 'notfound';
    for (let i = 0; i < 4 && saved === 'notfound'; i++) {
      saved = await ev('kn:save' + i, clickByText('/add to knowledge/i'));
      if (saved === 'notfound') await sleep(1500);
    }
    await sleep(7000);
    await ev('kn:after', body());
    await shot('w5d-2-after-save.jpg');

    // Playground
    await post('navigate', { url: 'https://app.makerbay.app/assistant/playground' });
    await sleep(5000);
    await ev('pg:ask', `(()=>{
      const el=[...document.querySelectorAll('input,textarea')].find(i=>i.offsetParent);
      if(!el) return 'noinput';
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,'What satisfaction guarantee do you offer?');
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'typed';
    })()`);
    await sleep(400);
    await ev('pg:send', clickByText('/^send$/i'));
    for (let i = 0; i < 7; i++) {
      await sleep(5000);
      const t = await ev('pg:poll' + i, body());
      if (t && /42/.test(t)) break;
    }
    await shot('w5d-3-answer.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

// W5c: actually save the knowledge source ("Add to knowledge"), then re-ask in playground.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w5c-log.json');
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
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2400))()`;

(async () => {
  try {
    // 1. Re-fill and save
    await post('navigate', { url: 'https://app.makerbay.app/assistant/knowledge' });
    await sleep(4500);
    await ev('kn:tab', clickByText('/^paste text$/i'));
    await sleep(1500);
    await ev('kn:fill', `(()=>{
      const n=document.querySelector('#k-name'), t=document.querySelector('#k-text');
      if(!n||!t) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'E2E Workshop Policy');
      n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Test page offers a 42-day satisfaction guarantee on all workshop bookings. If a customer is not happy within 42 days, we re-do the work free of charge. This policy was added for E2E testing.');
      t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true}));
      return 'filled';
    })()`);
    await sleep(500);
    await ev('kn:save', clickByText('/add to knowledge/i'));
    await sleep(6000);
    await ev('kn:after', body());
    await shot('w5c-1-source-added.jpg');

    // 2. Playground — ask again
    await post('navigate', { url: 'https://app.makerbay.app/assistant/playground' });
    await sleep(4500);
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
    await shot('w5c-2-answer.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

// W3c: create the quote draft (existing customer + price-list line), then inspect/send it.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w3c-log.json');
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
const buttons = () => `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim().replace(/\\s+/g,' ').slice(0,40))))()`;

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/quotes/new' });
    await sleep(4500);

    // 1. Select existing customer in q-contact
    await ev('q:contact', `(()=>{
      const s=document.querySelector('#q-contact'); if(!s) return 'nosel';
      const opts=[...s.options].map(o=>({v:o.value,t:o.textContent.trim()}));
      const target=[...s.options].find(o=>/E2E Workflow Customer/i.test(o.textContent));
      if(!target) return 'noopt '+JSON.stringify(opts);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,target.value);
      s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true}));
      return 'selected '+target.textContent.trim();
    })()`);
    await sleep(1200);

    // 2. Select price-list line in the line select, set qty=2
    await ev('q:line', `(()=>{
      const sels=[...document.querySelectorAll('select')].filter(x=>x.offsetParent&&x.id!=='q-contact');
      const s=sels.find(x=>[...x.options].some(o=>/E2E Labour/i.test(o.textContent)));
      if(!s) return 'nolinesel';
      const target=[...s.options].find(o=>/E2E Labour/i.test(o.textContent));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,target.value);
      s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true}));
      return 'line '+target.textContent.trim();
    })()`);
    await sleep(1200);
    await ev('q:qty', `(()=>{
      const nums=[...document.querySelectorAll('input[type=number]')].filter(i=>i.offsetParent);
      if(!nums.length) return 'nonum';
      const q=nums[0];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(q,'2');
      q.dispatchEvent(new Event('input',{bubbles:true})); q.dispatchEvent(new Event('change',{bubbles:true}));
      return 'qty set';
    })()`);
    await ev('q:notes', `(()=>{
      const n=document.querySelector('#q-notes'); if(!n) return 'nonotes';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'E2E workflow test quote — safe to decline or accept.');
      n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true}));
      return 'notes set';
    })()`);
    await sleep(800);
    await ev('q:preflight', body());
    await shot('w3c-1-quote-filled.jpg');

    // 3. Create draft
    await ev('q:create', clickByText('/create draft/i'));
    await sleep(4000);
    await ev('q:url', `(()=>location.href)()`);
    await ev('q:after', body());
    await ev('q:buttons', buttons());
    await ev('q:links', `(()=>JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>({t:a.textContent.trim().replace(/\\s+/g,' ').slice(0,40),h:a.href})).filter(x=>/quote|doc|q\\//i.test(x.h)&&!/quotes\\/new/.test(x.h)).slice(0,10)))()`);
    await shot('w3c-2-quote-detail.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

// W3b: add a price-list item; then open Quotes and inspect the new-quote form.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w3b-log.json');
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
const fields = () => `(()=>JSON.stringify([...document.querySelectorAll('input,textarea,select')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,id:i.id,name:i.name,ph:i.placeholder}))))()`;
const buttons = () => `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim().replace(/\\s+/g,' ').slice(0,40))))()`;

(async () => {
  try {
    // 1. Add price-list item via the 3 placeholder inputs
    await post('navigate', { url: 'https://app.makerbay.app/quotes/prices' });
    await sleep(4500);
    await ev('pl:fill', `(()=>{
      const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
      const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent);
      const d=ins.find(i=>/preparation/i.test(i.placeholder)), u=ins.find(i=>/^hour$/i.test(i.placeholder)), p=ins.find(i=>/95\\.00/.test(i.placeholder));
      if(!d||!u||!p) return 'missing';
      set(d,'E2E Labour'); set(u,'hour'); set(p,'95'); return 'filled';
    })()`);
    await ev('pl:add', `(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent); const b=bs.find(x=>/^add$/i.test(x.textContent.trim())); if(!b) return 'nobtn'; b.click(); return 'clicked'})()`);
    await sleep(3000);
    await ev('pl:after', body());
    await shot('w3b-1-price-added.jpg');

    // 2. Quotes list → New quote
    await post('navigate', { url: 'https://app.makerbay.app/quotes' });
    await sleep(4500);
    await ev('quotes:text', body());
    await ev('quotes:buttons', buttons());
    await shot('w3b-2-quotes.jpg');
    await ev('quote:new', clickByText('/new quote|create quote|first quote/i'));
    await sleep(2500);
    await ev('quote:url', `(()=>location.href)()`);
    await ev('quote:fields', fields());
    await ev('quote:buttons', buttons());
    await ev('quote:text', body());
    await shot('w3b-3-new-quote.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

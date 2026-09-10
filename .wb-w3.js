// W3: Quotes — add a price-list item, create a quote, send it, inspect the public link.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w3-log.json');
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
const setNative = (sel, val) => `(()=>{const d=document.querySelector('${sel}'); if(!d) return 'missing ${sel}';
  const proto=d.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:(d.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype);
  const set=Object.getOwnPropertyDescriptor(proto,'value').set;
  set.call(d,'${val}'); d.dispatchEvent(new Event('input',{bubbles:true})); d.dispatchEvent(new Event('change',{bubbles:true})); return d.value})()`;

(async () => {
  try {
    // 1. Price list
    await post('navigate', { url: 'https://app.makerbay.app/quotes/prices' });
    await sleep(4500);
    await ev('prices:text', body());
    await ev('prices:fields', fields());
    await ev('prices:buttons', buttons());
    await shot('w3-1-prices.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

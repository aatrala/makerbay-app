// W6: Your page — inspect form, fill intro, save, re-check preview (V1), Home checklist state.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w6-log.json');
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
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2400))()`;
const fields = () => `(()=>JSON.stringify([...document.querySelectorAll('input,textarea,select')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,id:i.id,ph:(i.placeholder||'').slice(0,50),v:(i.value||'').slice(0,40)}))))()`;
const buttons = () => `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40))))()`;

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/page' });
    await sleep(5000);
    await ev('pg:text', body());
    await ev('pg:fields', fields());
    await ev('pg:buttons', buttons());
    await shot('w6-1-page.jpg');
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

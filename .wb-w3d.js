// W3d: get the public quote link, open it as a customer, accept, verify owner side, create invoice.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w3d-log.json');
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
    // 1. On the quote detail — click "Get the link"
    await post('navigate', { url: 'https://app.makerbay.app/quotes/01M26A0SNQ13R0QHGF4N51W2BY' });
    await sleep(4500);
    await ev('link:click', clickByText('/get the link/i'));
    await sleep(2000);
    await shot('w3d-1-getlink.jpg');
    await ev('link:text', body());
    await ev('link:anchors', `(()=>JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>!/app\\.makerbay\\.app\\/(quotes(?!\\/)|$)|javascript/.test(h)).slice(0,10)))()`);
    await ev('link:inputs', `(()=>JSON.stringify([...document.querySelectorAll('input')].filter(i=>i.offsetParent).map(i=>({id:i.id,v:i.value.slice(0,120)}))))()`);

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

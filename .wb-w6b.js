// W6b: fill Your page content, save, re-check preview iframe (V1), then Home checklist.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w6b-log.json');
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
  log.push({ step: name, ok: !!r.ok, value: typeof v === 'string' ? v.slice(0, 900) : v, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test((e.textContent||'').replace(/\\s+/g,' ').trim())); if(!b) return 'notfound'; b.click(); return (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2400))()`;

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/page' });
    await sleep(5000);
    await ev('pg:fill', `(()=>{
      const setI=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const setT=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      const set=(el,v,s)=>{if(!el) return; s.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
      set(document.querySelector('#p-headline'),'E2E test workshop, Coimbatore',setI);
      set(document.querySelector('#p-intro'),'This is an end-to-end test page for MakerBay workflow verification. It exists so testers can check publishing, preview and sharing behaviour. Please ignore it.',setT);
      set(document.querySelector('#p-areas'),'Kalapatti, Saravanampatti',setI);
      set(document.querySelector('#p-email'),'aatrala+b1@gmail.com',setI);
      return 'filled';
    })()`);
    await sleep(600);
    await shot('w6b-1-filled.jpg');
    await ev('pg:save', clickByText('/^save page$/i'));
    await sleep(5000);
    await ev('pg:after', body());
    await shot('w6b-2-saved.jpg');

    // Preview iframe — V1 recheck
    await ev('pv:iframes', `(()=>JSON.stringify([...document.querySelectorAll('iframe')].map(f=>f.src)))()`);
    await ev('pv:refresh', clickByText('/^refresh$/i'));
    await sleep(4000);
    await shot('w6b-3-preview.jpg');

    // Home checklist
    await post('navigate', { url: 'https://app.makerbay.app/home' });
    await sleep(5000);
    await ev('home:text', body());
    await shot('w6b-4-home.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

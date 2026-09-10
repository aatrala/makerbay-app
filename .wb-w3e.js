// W3e: open public quote as customer, accept it; verify owner side; create invoice.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w3e-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTE_URL = 'https://quote.makerbay.app/test-page/Q-001/v8umF2kl3FaQkZvm0W8IgMXTMmbLfs0N';
const OWNER_URL = 'https://app.makerbay.app/quotes/01M26A0SNQ13R0QHGF4N51W2BY';
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
    // 1. Customer view of the quote
    await post('navigate', { url: QUOTE_URL });
    await sleep(5000);
    await ev('pub:text', body());
    await ev('pub:buttons', buttons());
    await ev('pub:fields', `(()=>JSON.stringify([...document.querySelectorAll('input,textarea')].filter(i=>i.offsetParent).map(i=>({id:i.id,ph:i.placeholder,type:i.type}))))()`);
    await shot('w3e-1-public-quote.jpg');

    // 2. Accept: type name if a name input exists, then click Accept
    await ev('pub:name', `(()=>{
      const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);
      if(!i) return 'noinput';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'E2E Workflow Customer');
      i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}));
      return 'name set';
    })()`);
    await ev('pub:accept', clickByText('/^accept/i'));
    await sleep(1500);
    // possible confirm step
    await ev('pub:accept2', clickByText('/^accept|confirm|yes/i'));
    await sleep(3500);
    await ev('pub:after', body());
    await shot('w3e-2-accepted.jpg');

    // 3. Owner view — status?
    await post('navigate', { url: OWNER_URL });
    await sleep(4500);
    await ev('own:text', body());
    await ev('own:buttons', buttons());
    await shot('w3e-3-owner-after-accept.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

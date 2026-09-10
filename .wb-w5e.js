// W5e: Genie — ask about bookings and quotes; verify real-data provenance.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w5e-log.json');
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
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(-2600))()`;
const fields = () => `(()=>JSON.stringify([...document.querySelectorAll('input,textarea')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,id:i.id,ph:i.placeholder.slice(0,60)}))))()`;

async function ask(question, tag) {
  await ev(tag + ':type', `(()=>{
    const el=[...document.querySelectorAll('input,textarea')].find(i=>i.offsetParent);
    if(!el) return 'noinput';
    const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(question)});
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'typed';
  })()`);
  await sleep(400);
  await ev(tag + ':send', clickByText('/^send$|^ask$/i'));
  for (let i = 0; i < 8; i++) {
    await sleep(5000);
    const t = await ev(tag + ':poll' + i, body());
    if (t && !/…$/.test(t) && /(checked|source|booking|quote|nothing|no )/i.test(t)) break;
  }
  await shot('w5e-' + tag + '.jpg');
}

(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/genie' });
    await sleep(5000);
    await ev('g:text', body());
    await ev('g:fields', fields());
    await shot('w5e-0-genie.jpg');

    await ask('What is booked this week?', 'q1');
    await ask('How is my latest quote doing?', 'q2');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

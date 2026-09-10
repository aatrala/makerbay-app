// Workflow pass W1: inspect Services + Hours screens (snapshot), no writes yet.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'w1-log.json');
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
  log.push({ step: name, ok: !!r.ok, err: r.error || null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error || null });
  return r.ok ? r.data.value : null;
}
(async () => {
  try {
    await post('navigate', { url: 'https://app.makerbay.app/booking/services' });
    await sleep(4000);
    await shot('w1-services.jpg');
    await ev('services:body', 'document.body.innerText.slice(0,600)');
    // open the add-service form if present
    await ev('services:add-click', "(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>e.offsetParent&&/add|new|create|first service/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,40)})()");
    await sleep(1500);
    await shot('w1-services-form.jpg');
    await ev('services:form-fields', "(()=>{const ins=[...document.querySelectorAll('input,select,textarea')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,name:i.name,id:i.id,ph:i.placeholder,label:i.closest('label')?i.closest('label').textContent.trim().slice(0,40):''})); return JSON.stringify(ins)})()");
    await post('navigate', { url: 'https://app.makerbay.app/booking/hours' });
    await sleep(4000);
    await shot('w1-hours.jpg');
    await ev('hours:body', 'document.body.innerText.slice(0,800)');
    log.push({ step: 'DONE', ok: true });
  } catch (e) { log.push({ step: 'FATAL', ok: false, err: String(e) }); }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();

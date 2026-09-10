// MakerBay visual E2E — Part C1: sign-in screen + request code for aatrala+b1@gmail.com
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'partC1-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(action, args = {}) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: S }),
  });
  return res.json();
}
async function shot(name) {
  const r = await post('screenshot', { format: 'jpeg', quality: 70, path: path.join(SHOTS, name) });
  log.push({ step: name, ok: !!r.ok, bytes: r.data?.sizeBytes ?? null, err: r.error || null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error || null });
  return r.ok ? r.data.value : null;
}

(async () => {
  try {
    const r = await post('navigate', { url: 'https://app.makerbay.app' });
    log.push({ step: 'nav:app', ok: !!r.ok, err: r.error || null });
    await sleep(6000);
    await shot('signin-1-landing.jpg');
    await ev('signin:url', 'location.href');
    await ev('signin:body-text', 'document.body.innerText.slice(0,300)');

    // If already signed in, stop and report — do not request a code
    const state = await ev('signin:has-email-input', "(()=>{const i=document.querySelector('input[type=email],input[name=email],input[autocomplete=email]'); return i?'email-input':'none'})()");
    if (state === 'email-input') {
      await post('fill', { selector: 'input[type=email], input[name=email], input[autocomplete=email]', value: 'aatrala+b1@gmail.com' });
      await sleep(400);
      await shot('signin-2-email-filled.jpg');
      await ev('signin:submit', "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent&&/code|continue|sign in|send/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return b.textContent.trim().slice(0,40)})()");
      await sleep(4000);
      await shot('signin-3-code-screen.jpg');
      await ev('signin:after-submit', 'document.body.innerText.slice(0,300)');
    }
    log.push({ step: 'DONE', ok: true });
  } catch (e) {
    log.push({ step: 'FATAL', ok: false, err: String(e) });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();

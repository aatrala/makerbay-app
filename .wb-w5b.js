// W5b: paste a knowledge source, ask about it in the playground, then query Genie.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w5b-log.json');
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
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2200))()`;
const buttons = () => `(()=>JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim().replace(/\\s+/g,' ').slice(0,40))))()`;
const fields = () => `(()=>JSON.stringify([...document.querySelectorAll('input,textarea,select')].filter(i=>i.offsetParent).map(i=>({tag:i.tagName,type:i.type,id:i.id,ph:i.placeholder.slice(0,60)}))))()`;

(async () => {
  try {
    // 1. Knowledge → Paste text tab
    await post('navigate', { url: 'https://app.makerbay.app/assistant/knowledge' });
    await sleep(4500);
    await ev('kn:tab', clickByText('/^paste text$/i'));
    await sleep(1500);
    await ev('kn:fields2', fields());
    await ev('kn:buttons2', buttons());
    await shot('w5b-1-paste-tab.jpg');

    // 2. Fill the paste form (title + body)
    await ev('kn:fill', `(()=>{
      const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent);
      const ta=[...document.querySelectorAll('textarea')].filter(i=>i.offsetParent);
      const setI=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const setT=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      const out=[];
      if(ins.length){setI.call(ins[0],'E2E Workshop Policy'); ins[0].dispatchEvent(new Event('input',{bubbles:true})); ins[0].dispatchEvent(new Event('change',{bubbles:true})); out.push('title');}
      if(ta.length){setT.call(ta[0],'Test page offers a 42-day satisfaction guarantee on all workshop bookings. If a customer is not happy within 42 days, we re-do the work free of charge. This policy was added for E2E testing.'); ta[0].dispatchEvent(new Event('input',{bubbles:true})); ta[0].dispatchEvent(new Event('change',{bubbles:true})); out.push('body');}
      return JSON.stringify(out);
    })()`);
    await sleep(600);
    await shot('w5b-2-paste-filled.jpg');
    await ev('kn:save', clickByText('/^add$|save|add knowledge|add source/i'));
    await sleep(5000);
    await ev('kn:after', body());
    await shot('w5b-3-source-added.jpg');

    // 3. Playground — ask about the guarantee
    await post('navigate', { url: 'https://app.makerbay.app/assistant/playground' });
    await sleep(4500);
    await ev('pg:text', body());
    await ev('pg:fields', fields());
    await shot('w5b-4-playground.jpg');
    await ev('pg:ask', `(()=>{
      const ta=[...document.querySelectorAll('textarea,input')].filter(i=>i.offsetParent);
      if(!ta.length) return 'noinput';
      const el=ta[0];
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,'What satisfaction guarantee do you offer?');
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'typed';
    })()`);
    await sleep(400);
    await ev('pg:send', clickByText('/^send$|^ask$/i'));
    // wait for answer (LLM latency)
    for (let i = 0; i < 6; i++) { await sleep(5000); const t = await ev('pg:poll' + i, body()); if (t && /42/.test(t)) break; }
    await shot('w5b-5-playground-answer.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();

export function loginPage(profile: string, ticket: string): string {
  const p = JSON.stringify(profile);
  const t = JSON.stringify(ticket);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>sessionfarm — ${profile}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#111; color:#ddd; font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { display:flex; gap:8px; align-items:center; padding:8px; background:#1a1a1a; border-bottom:1px solid #333; }
  input { flex:1; background:#0d0d0d; color:#ddd; border:1px solid #333; padding:6px 8px; border-radius:4px; font:inherit; }
  button { background:#2a2a2a; color:#ddd; border:1px solid #444; padding:6px 12px; border-radius:4px; cursor:pointer; font:inherit; }
  button:hover { background:#333; }
  #wrap { display:flex; justify-content:center; padding:12px; }
  #screen { max-width:100%; border:1px solid #333; cursor:default; display:block; }
  #screen:focus { outline:2px solid #4a7; }
  #status { padding:6px 10px; color:#888; }
  .tag { padding:2px 6px; border-radius:3px; background:#252525; color:#9c9; }
</style></head><body>
<header>
  <span class="tag">${profile}</span>
  <button id="back">←</button>
  <input id="url" placeholder="https://… then Enter" spellcheck="false">
  <button id="done">Done — check login</button>
</header>
<div id="wrap"><img id="screen" tabindex="0" alt="remote browser"></div>
<div id="status">connecting…</div>
<script>
const PROFILE = ${p}, TICKET = ${t};
const img = document.getElementById('screen'), status = document.getElementById('status');
const urlBar = document.getElementById('url');
let frame = { w: 1280, h: 800 };

const es = new EventSource('/login/' + encodeURIComponent(PROFILE) + '/stream?ticket=' + encodeURIComponent(TICKET));
es.onmessage = (e) => {
  const f = JSON.parse(e.data);
  frame = f;
  window.__frame = f;   // read by the e2e test to map page coordinates
  img.src = 'data:image/jpeg;base64,' + f.img;
  status.textContent = f.url || '';
};
es.onerror = () => { status.textContent = 'stream disconnected'; };

function send(ev) {
  return fetch('/login/' + encodeURIComponent(PROFILE) + '/input?ticket=' + encodeURIComponent(TICKET), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
  });
}

// The image is CSS-scaled, so client pixels must be mapped back into the
// viewport's own coordinate space or every click lands in the wrong place.
function at(e) {
  const r = img.getBoundingClientRect();
  return { x: Math.round((e.clientX - r.left) / r.width * frame.w),
           y: Math.round((e.clientY - r.top) / r.height * frame.h) };
}
function mods(e) { return (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0); }

let lastMove = 0;
img.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMove < 40) return;      // ~25fps of pointer updates is plenty
  lastMove = now;
  send({ type:'mouse', action:'move', ...at(e) });
});
img.addEventListener('mousedown', (e) => { e.preventDefault(); urlBar.blur(); img.focus(); send({ type:'mouse', action:'down', ...at(e), modifiers:mods(e) }); });
img.addEventListener('mouseup',   (e) => { e.preventDefault(); send({ type:'mouse', action:'up',   ...at(e), modifiers:mods(e) }); });
img.addEventListener('contextmenu', (e) => e.preventDefault());
img.addEventListener('wheel', (e) => { e.preventDefault(); send({ type:'scroll', ...at(e), deltaX:e.deltaX, deltaY:e.deltaY }); }, { passive:false });

window.addEventListener('keydown', (e) => {
  if (document.activeElement === urlBar) return;
  e.preventDefault();
  // Printable characters go through insertText so unicode and IME survive;
  // everything else needs a real key event to trigger form behaviour.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ type:'text', text:e.key });
  else send({ type:'key', action:'down', key:e.key, code:e.code, modifiers:mods(e) });
});
window.addEventListener('paste', (e) => {
  if (document.activeElement === urlBar) return;
  e.preventDefault();
  send({ type:'text', text: e.clipboardData.getData('text') });
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  let u = urlBar.value.trim();
  if (u && !u.startsWith('http:') && !u.startsWith('https:')) u = 'https://' + u;
  send({ type:'nav', url:u });
});
document.getElementById('back').onclick = () => send({ type:'back' });
document.getElementById('done').onclick = async () => {
  status.textContent = 'checking…';
  const r = await fetch('/login/' + encodeURIComponent(PROFILE) + '/done?ticket=' + encodeURIComponent(TICKET), { method:'POST' });
  const j = await r.json();
  status.textContent = 'health: ' + j.state + (j.detail ? ' — ' + j.detail : '');
};
</script></body></html>`;
}

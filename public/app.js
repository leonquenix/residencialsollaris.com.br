// Helpers compartilhados entre as páginas.
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('Sessão expirada'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}

function toast(msg, type = '') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = `show ${type}`;
  clearTimeout(el._t); el._t = setTimeout(() => (el.className = ''), 3000);
}

const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const fmtCpf = (l) => /^\d{11}$/.test(l) ? l.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : l;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Emoji decorativo conforme o nome do voucher.
function emojiFor(label) {
  const l = String(label).toLowerCase();
  const map = [['suco', '🧃'], ['cachorro', '🌭'], ['pipoca', '🍿'], ['algod', '🍭'], ['refri', '🥤'], ['água', '💧'], ['agua', '💧'],
    ['sorvete', '🍦'], ['bolo', '🍰'], ['picol', '🍧'], ['doce', '🍬'], ['brinquedo', '🧸'], ['pizza', '🍕'], ['hamb', '🍔'], ['pastel', '🥟'], ['churros', '🍩']];
  return (map.find(([k]) => l.includes(k)) || [null, '🎟️'])[1];
}

function balloons() {
  const d = document.createElement('div'); d.className = 'balloons';
  d.innerHTML = '<span>🎈</span><span>🎉</span><span>🎈</span><span>🎀</span><span>🎈</span>';
  document.body.prepend(d);
}

async function logout() { await api('/api/logout', { body: {} }); location.href = '/'; }

// Barra superior com nome do usuário e botão sair.
function topbar(me, subtitle) {
  const el = document.querySelector('.topbar');
  if (!el) return;
  el.innerHTML = `
    <div>
      <div class="title">🎪 Festa do Dia das Crianças</div>
      <div class="who">${esc(subtitle || '')} · ${esc(me.name)}</div>
    </div>
    <button class="btn-ghost btn-sm" onclick="logout()">Sair</button>`;
}

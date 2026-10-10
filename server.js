// Servidor único: API JSON + páginas estáticas. Rode com `npm start`.
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROLES = ['admin', 'vendedor', 'cliente'];

// ---------- helpers ----------
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(db.DATA_DIR, 'session-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

// "430.739.028-80" -> "43073902880"; "admin" -> "admin"
function normalizeLogin(s = '') {
  const digits = String(s).replace(/\D/g, '');
  return digits.length === 11 ? digits : String(s).trim().toLowerCase();
}

// Aceita "43073902880-1", "430.739.028-80 - 1", "43073902880 1"...
function normalizeCode(raw = '') {
  const s = String(raw).trim().replace(/\s+/g, '-').replace(/[^\d-]/g, '');
  const idx = s.lastIndexOf('-');
  if (idx < 0) return null;
  const login = s.slice(0, idx).replace(/-/g, '');
  const seq = s.slice(idx + 1);
  if (login.length !== 11 || !/^\d+$/.test(seq)) return null;
  return `${login}-${Number(seq)}`;
}

// Expande a lista de vouchers pedida em rótulos individuais (um por voucher).
// Aceita objeto { "Suco": 5, "Cachorro-quente": 6 }, array ["Suco","Suco"] ou texto
// "Suco=5|Cachorro-quente=6" (também "Suco x5", "Suco:5", "Suco*5" ou só "Suco" = 1).
function expandVouchers(input) {
  const out = [];
  const push = (label, qty) => { for (let i = 0; i < Math.min(Number(qty) || 0, 500); i++) out.push(label); };
  if (Array.isArray(input)) { input.forEach((l) => l && push(String(l).trim(), 1)); return out; }
  if (input && typeof input === 'object') { for (const [k, v] of Object.entries(input)) if (k.trim()) push(k.trim(), v); return out; }
  for (const part of String(input || '').split(/[|,\n]/)) {
    const m = part.trim().match(/^(.*?)\s*(?:[=:x*×]\s*(\d+))?$/i);
    if (m && m[1]) push(m[1].trim(), m[2] ?? 1);
  }
  return out;
}
const hash = (pw) => bcrypt.hashSync(String(pw), 10);

// Senhas no padrão quadra/lote ("Q3L7") valem em maiúscula ou minúscula,
// não importa como foram cadastradas. Outras senhas comparam exatamente.
function checkPassword(raw, password_hash) {
  const pw = String(raw ?? '');
  const candidates = /^q\d+l\d+$/i.test(pw.trim())
    ? new Set([pw.trim().toUpperCase(), pw.trim().toLowerCase()])
    : [pw];
  for (const c of candidates) if (bcrypt.compareSync(c, password_hash)) return true;
  return false;
}
const bad = (res, status, error) => res.status(status).json({ error });

function requireRole(...roles) {
  return (req, res, next) => {
    const s = req.session;
    if (!s?.uid) return bad(res, 401, 'Faça login');
    if (!roles.includes(s.role)) return bad(res, 403, 'Sem permissão');
    next();
  };
}

// Limite simples de tentativas de login por IP (20 a cada 10 min), em memória.
const attempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  const a = attempts.get(req.ip) || { n: 0, reset: now + 600_000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 600_000; }
  if (a.n >= 20) return bad(res, 429, 'Muitas tentativas. Tente de novo em alguns minutos.');
  a.n += 1;
  attempts.set(req.ip, a);
  next();
}

// ---------- bootstrap do admin ----------
if (db.countAdmins() === 0) {
  const login = normalizeLogin(process.env.ADMIN_LOGIN || 'admin');
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.createUser({ login, name: 'Administrador', role: 'admin', password_hash: hash(password) });
  console.log(`\n>>> Admin criado: login "${login}" senha "${password}". TROQUE A SENHA no painel admin!\n`);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({
  name: 'festa',
  secret: loadSecret(),
  maxAge: 30 * 24 * 3600 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));

// ----- auth -----
app.post('/api/login', loginLimiter, (req, res) => {
  const login = normalizeLogin(req.body?.login);
  const user = login && db.getUserByLogin(login);
  if (!user || !checkPassword(req.body?.password, user.password_hash)) {
    return bad(res, 401, 'CPF ou senha incorretos');
  }
  req.session = { uid: user.id, role: user.role };
  res.json({ role: user.role, name: user.name });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  const user = req.session?.uid && db.getUserById(req.session.uid);
  if (!user) { req.session = null; return bad(res, 401, 'Faça login'); }
  res.json(user);
});

// ----- cliente -----
app.get('/api/cliente/vouchers', requireRole('cliente'), async (req, res) => {
  const vouchers = db.listVouchers(req.session.uid);
  const out = [];
  for (const v of vouchers) {
    const qr = await QRCode.toDataURL(v.code, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    out.push({ id: v.id, seq: v.seq, code: v.code, label: v.label, redeemed_at: v.redeemed_at, redeemed_by_name: v.redeemed_by_name, qr });
  }
  res.json(out);
});

// ----- vendedor -----
// Consulta sem consumir: alimenta o pop-up de confirmação.
app.get('/api/vendedor/consultar', requireRole('vendedor', 'admin'), (req, res) => {
  const code = normalizeCode(req.query.code);
  if (!code) return res.json({ ok: false, error: 'formato_invalido' });
  const voucher = db.findVoucherByCode(code);
  if (!voucher) return res.json({ ok: false, error: 'nao_encontrado' });
  if (voucher.redeemed_at) return res.json({ ok: false, error: 'ja_usado', voucher });
  res.json({ ok: true, voucher });
});

app.post('/api/vendedor/validar', requireRole('vendedor', 'admin'), (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.json({ ok: false, error: 'formato_invalido' });
  res.json(db.redeem(code, req.session.uid));
});

app.get('/api/vendedor/historico', requireRole('vendedor', 'admin'), (req, res) => {
  res.json(db.recentRedemptions(30, req.session.uid));
});

// ----- admin -----
const admin = express.Router();
admin.use(requireRole('admin'));

admin.get('/stats', (req, res) => res.json({ ...db.stats(), recentes: db.recentRedemptions(20) }));
admin.get('/users', (req, res) => res.json(db.listUsers()));

admin.get('/users/:id', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return bad(res, 404, 'Não encontrado');
  res.json({ ...user, vouchers: db.listVouchers(user.id) });
});

function validateNewUser({ login, name, role, password }) {
  const l = normalizeLogin(login);
  if (role !== 'admin' && !/^\d{11}$/.test(l)) return { error: 'CPF precisa ter 11 dígitos' };
  if (db.getUserByLogin(l)) return { error: `Já existe cadastro para ${l}` };
  if (!ROLES.includes(role)) return { error: 'Tipo inválido' };
  if (!name?.trim()) return { error: 'Nome obrigatório' };
  if (!password || String(password).length < 4) return { error: 'Senha precisa ter pelo menos 4 caracteres' };
  return { login: l, name: name.trim(), role, password: String(password) };
}

admin.post('/users', (req, res) => {
  const v = validateNewUser(req.body || {});
  if (v.error) return bad(res, 400, v.error);
  const user = db.createUser({ login: v.login, name: v.name, role: v.role, password_hash: hash(v.password) });
  const labels = expandVouchers(req.body.vouchers);
  const vouchers = v.role === 'cliente' && labels.length ? db.addVouchers(user.id, labels) : [];
  res.status(201).json({ ...user, vouchers });
});

// Importação em massa. Uma pessoa por linha: CPF;Nome;Senha;Suco=5|Cachorro-quente=6
admin.post('/users/import', (req, res) => {
  const lines = String(req.body?.text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const report = { criados: 0, vouchers: 0, erros: [] };
  lines.forEach((line, i) => {
    const [login, name, password, vouchersRaw = ''] = line.split(/\t|;/).map((x) => x.trim());
    const v = validateNewUser({ login, name, role: 'cliente', password });
    if (v.error) return report.erros.push(`Linha ${i + 1}: ${v.error}`);
    const user = db.createUser({ login: v.login, name: v.name, role: 'cliente', password_hash: hash(v.password) });
    const created = db.addVouchers(user.id, expandVouchers(vouchersRaw));
    report.criados += 1;
    report.vouchers += created.length;
  });
  res.json(report);
});

admin.post('/users/:id/password', (req, res) => {
  const pw = String(req.body?.password ?? '');
  if (pw.length < 4) return bad(res, 400, 'Senha precisa ter pelo menos 4 caracteres');
  if (!db.getUserById(req.params.id)) return bad(res, 404, 'Não encontrado');
  db.setPassword(req.params.id, hash(pw));
  res.json({ ok: true });
});

admin.post('/users/:id/vouchers', (req, res) => {
  const labels = expandVouchers(req.body?.labels ?? req.body?.vouchers);
  if (!labels.length) return bad(res, 400, 'Informe pelo menos um voucher');
  if (!db.getUserById(req.params.id)) return bad(res, 404, 'Não encontrado');
  res.status(201).json(db.addVouchers(req.params.id, labels));
});

admin.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.session.uid) return bad(res, 400, 'Você não pode excluir a si mesmo');
  res.json({ ok: db.deleteUser(req.params.id) === 1 });
});

admin.get('/types', (req, res) => res.json(db.listTypes()));
admin.post('/types', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 400, 'Informe o nome do tipo');
  if (db.listTypes().some((t) => t.name.toLowerCase() === name.toLowerCase())) return bad(res, 400, 'Esse tipo já existe');
  res.status(201).json({ id: db.addType(name), name });
});
admin.delete('/types/:id', (req, res) => res.json({ ok: db.deleteType(req.params.id) === 1 }));

admin.post('/vouchers/:id/reset', (req, res) => res.json({ ok: db.resetVoucher(req.params.id) === 1 }));
admin.delete('/vouchers/:id', (req, res) => res.json({ ok: db.deleteVoucher(req.params.id) === 1 }));

app.use('/api/admin', admin);

// ----- páginas -----
const page = (file) => path.join(__dirname, 'public', file);
const pageFor = (roles, file) => (req, res) => {
  const role = req.session?.role;
  if (!role || !roles.includes(role)) return res.redirect('/');
  res.sendFile(page(file));
};

app.get('/', (req, res) => {
  const home = { admin: '/admin', vendedor: '/vendedor', cliente: '/cliente' }[req.session?.role];
  if (home && db.getUserById(req.session.uid)) return res.redirect(home);
  res.sendFile(page('login.html'));
});
app.get('/cliente', pageFor(['cliente'], 'cliente.html'));
app.get('/vendedor', pageFor(['vendedor', 'admin'], 'vendedor.html'));
app.get('/admin', pageFor(['admin'], 'admin.html'));

app.use('/vendor/jsQR.js', express.static(path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  bad(res, 500, 'Erro interno');
});

app.listen(PORT, () => console.log(`Festa rodando em http://localhost:${PORT}`));

// Camada de dados: SQLite embutido no Node (node:sqlite). Um único arquivo em data/festa.db.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'festa.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login         TEXT NOT NULL UNIQUE,          -- CPF (só dígitos) ou "admin"
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin','vendedor','cliente')),
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,                 -- número curto por pessoa: 1, 2, 3...
    code        TEXT NOT NULL UNIQUE,             -- "<login>-<seq>", ex: 43073902880-1
    label       TEXT NOT NULL,                    -- ex: "Pipoca", "Algodão doce"
    redeemed_at TEXT,
    redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (user_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_vouchers_user ON vouchers(user_id);

  CREATE TABLE IF NOT EXISTS voucher_types (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE                     -- ex: "Suco", "Cachorro-quente"
  );
`);

// Tipos iniciais (só quando a tabela está vazia). O admin pode mudar no painel.
if (db.prepare(`SELECT COUNT(*) AS n FROM voucher_types`).get().n === 0) {
  for (const name of ['Suco', 'Cachorro-quente', 'Picolé']) db.prepare(`INSERT INTO voucher_types (name) VALUES (?)`).run(name);
}

const q = (sql) => db.prepare(sql);

// ---------- usuários ----------
export const countAdmins = () => q(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
// Ignora pontos, traços e espaços do que está gravado: alguns CPFs foram cadastrados
// formatados ("430.739.028-80") e precisam bater com o login só em dígitos.
export const getUserByLogin = (login) => q(`
  SELECT * FROM users
  WHERE login = ? OR REPLACE(REPLACE(REPLACE(login, '.', ''), '-', ''), ' ', '') = ?
  ORDER BY login = ? DESC LIMIT 1
`).get(login, login, login);
export const getUserById = (id) => q(`SELECT id, login, name, role, created_at FROM users WHERE id = ?`).get(id);

export function createUser({ login, name, role, password_hash }) {
  const r = q(`INSERT INTO users (login, name, role, password_hash) VALUES (?, ?, ?, ?)`).run(login, name, role, password_hash);
  return getUserById(r.lastInsertRowid);
}

export const setPassword = (id, password_hash) => q(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, id);
export const deleteUser = (id) => q(`DELETE FROM users WHERE id = ?`).run(id).changes;

export const listUsers = () => q(`
  SELECT u.id, u.login, u.name, u.role, u.created_at,
         COUNT(v.id) AS total,
         SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS usados
  FROM users u LEFT JOIN vouchers v ON v.user_id = u.id
  GROUP BY u.id
  ORDER BY u.role, u.name
`).all();

// ---------- tipos de voucher ----------
export const listTypes = () => q(`SELECT * FROM voucher_types ORDER BY id`).all();
export const addType = (name) => q(`INSERT INTO voucher_types (name) VALUES (?)`).run(name).lastInsertRowid;
export const deleteType = (id) => q(`DELETE FROM voucher_types WHERE id = ?`).run(id).changes;

// ---------- vouchers ----------
export function addVouchers(userId, labels) {
  const user = getUserById(userId);
  if (!user) return [];
  db.exec('BEGIN');
  try {
    let seq = q(`SELECT COALESCE(MAX(seq), 0) AS m FROM vouchers WHERE user_id = ?`).get(userId).m;
    const ins = q(`INSERT INTO vouchers (user_id, seq, code, label) VALUES (?, ?, ?, ?)`);
    const created = [];
    for (const label of labels) {
      seq += 1;
      const code = `${user.login}-${seq}`;
      ins.run(userId, seq, code, label);
      created.push({ seq, code, label });
    }
    db.exec('COMMIT');
    return created;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const VOUCHER_SELECT = `
  SELECT v.id, v.user_id, v.seq, v.code, v.label, v.redeemed_at,
         u.name AS owner_name, u.login AS owner_login,
         r.name AS redeemed_by_name
  FROM vouchers v
  JOIN users u ON u.id = v.user_id
  LEFT JOIN users r ON r.id = v.redeemed_by`;

export const listVouchers = (userId) => q(`${VOUCHER_SELECT} WHERE v.user_id = ? ORDER BY v.seq`).all(userId);
export const findVoucherByCode = (code) => q(`${VOUCHER_SELECT} WHERE v.code = ?`).get(code);

// Resgate atômico: só marca se ainda não foi usado. Duas leituras simultâneas nunca validam o mesmo voucher.
export function redeem(code, vendorId) {
  const r = q(`UPDATE vouchers SET redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), redeemed_by = ?
               WHERE code = ? AND redeemed_at IS NULL`).run(vendorId, code);
  const voucher = findVoucherByCode(code);
  if (r.changes === 1) return { ok: true, voucher };
  if (!voucher) return { ok: false, error: 'nao_encontrado' };
  return { ok: false, error: 'ja_usado', voucher };
}

export const resetVoucher = (id) => q(`UPDATE vouchers SET redeemed_at = NULL, redeemed_by = NULL WHERE id = ?`).run(id).changes;
export const deleteVoucher = (id) => q(`DELETE FROM vouchers WHERE id = ?`).run(id).changes;

export const recentRedemptions = (limit = 30, vendorId = null) => q(`
  ${VOUCHER_SELECT}
  WHERE v.redeemed_at IS NOT NULL AND (? IS NULL OR v.redeemed_by = ?)
  ORDER BY v.redeemed_at DESC LIMIT ?`).all(vendorId, vendorId, limit);

export const stats = () => ({
  ...q(`SELECT COUNT(*) AS vouchers, SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS usados FROM vouchers`).get(),
  clientes: q(`SELECT COUNT(*) AS n FROM users WHERE role = 'cliente'`).get().n,
  vendedores: q(`SELECT COUNT(*) AS n FROM users WHERE role = 'vendedor'`).get().n,
  porTipo: q(`SELECT label, COUNT(*) AS total, SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS usados
              FROM vouchers GROUP BY label ORDER BY total DESC`).all(),
});

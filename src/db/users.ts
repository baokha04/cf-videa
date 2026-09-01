import type { Env } from '../types';
import { newId, now } from '../util/id';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  password_changed_at: number;
}

export async function findByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first<UserRow>();
}

export async function findById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

/** Trả về null khi email đã tồn tại (bắt lỗi UNIQUE thay vì kiểm tra trước — tránh đua). */
export async function insert(
  env: Env,
  email: string,
  passwordHash: string,
  displayName: string | null,
): Promise<UserRow | null> {
  const t = now();
  const id = newId();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, status,
                          created_at, updated_at, password_changed_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5, ?5)`,
    )
      .bind(id, email, passwordHash, displayName, t)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) return null;
    throw err;
  }
  return {
    id,
    email,
    password_hash: passwordHash,
    display_name: displayName,
    status: 'active',
    created_at: t,
    updated_at: t,
    password_changed_at: t,
  };
}

export async function updatePasswordHash(
  env: Env,
  userId: string,
  passwordHash: string,
  markChanged: boolean,
): Promise<void> {
  const t = now();
  const sql = markChanged
    ? `UPDATE users SET password_hash = ?2, updated_at = ?3, password_changed_at = ?3 WHERE id = ?1`
    : `UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1`;
  await env.DB.prepare(sql).bind(userId, passwordHash, t).run();
}

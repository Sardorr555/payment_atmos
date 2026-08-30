/**
 * ragflow.js — RAGFlow user provisioning service
 *
 * Handles:
 *  - Admin auth → prefers RAGFLOW_API_KEY (no session invalidation)
 *    Falls back to email/password login via /v1/auth/login
 *  - Password RSA encryption (required by RAGFlow login)
 *  - Subscription provisioning via /api/v1/system/provision
 */

import crypto from 'crypto';
import fs from 'fs';
import fetch from 'node-fetch';

const BASE = process.env.RAGFLOW_BASE_URL; // e.g. https://app.swipies.app

// ─────────────────────────────────────────────────────────────────────────────
//  RSA Password encryption (RAGFlow requires this for login)
// ─────────────────────────────────────────────────────────────────────────────
let _publicKey = null;

const getPublicKey = () => {
  if (_publicKey) return _publicKey;
  try {
    const keyPath = process.env.RAGFLOW_PUBLIC_KEY_PATH || './ragflow_public.pem';
    _publicKey = fs.readFileSync(keyPath, 'utf8');
    return _publicKey;
  } catch {
    throw new Error(
      'RAGFlow public.pem not found. Copy it from your RAGFlow server: ragflow/conf/public.pem → server/ragflow_public.pem'
    );
  }
};

const encryptPassword = (plainPassword) => {
  const publicKey = getPublicKey();
  const b64Password = Buffer.from(plainPassword, 'utf-8').toString('base64');
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(b64Password, 'utf-8')
  );
  return encrypted.toString('base64');
};

// ─────────────────────────────────────────────────────────────────────────────
//  Admin auth token
//
//  Priority:
//    1. RAGFLOW_API_KEY env var  → use directly, no login needed, no session kill
//    2. RAGFLOW_ADMIN_EMAIL + RAGFLOW_ADMIN_PASSWORD → login via /v1/auth/login
// ─────────────────────────────────────────────────────────────────────────────
let _adminToken = null;
let _adminTokenExpiry = 0;

const getAdminToken = async () => {
  // ── Option 1: static API key (preferred — won't invalidate user sessions) ──
  const apiKey = process.env.RAGFLOW_API_KEY;
  if (apiKey) {
    return apiKey;
  }

  // ── Option 2: email/password session login ──
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken;

  const email = process.env.RAGFLOW_ADMIN_EMAIL;
  const password = process.env.RAGFLOW_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'Set either RAGFLOW_API_KEY (recommended) or both RAGFLOW_ADMIN_EMAIL and RAGFLOW_ADMIN_PASSWORD in server/.env'
    );
  }

  const encPsw = encryptPassword(password);

  // Correct RAGFlow v0.26.x login endpoint: /v1/auth/login
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: encPsw }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RAGFlow admin login failed: ${text}`);
  }

  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`RAGFlow admin login failed: ${data.message}`);
  }

  // Token valid ~24h; refresh every 20h to be safe
  _adminToken = data.data.token;
  _adminTokenExpiry = Date.now() + 20 * 60 * 60 * 1000;

  console.log('[RAGFlow] Admin session refreshed via email/password login');
  return _adminToken;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Get all users (admin endpoint on port 9381 via /api/v1/admin/users)
// ─────────────────────────────────────────────────────────────────────────────
export const listUsers = async () => {
  const token = await getAdminToken();

  const res = await fetch(`${BASE}/api/v1/admin/users`, {
    headers: { Authorization: token },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list RAGFlow users: ${text}`);
  }

  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'Failed to list RAGFlow users');
  return data.data || [];
};

// ─────────────────────────────────────────────────────────────────────────────
//  Find user by email
// ─────────────────────────────────────────────────────────────────────────────
export const findUserByEmail = async (email) => {
  try {
    const users = await listUsers();
    return users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null;
  } catch (err) {
    // Non-fatal: if user listing fails, we proceed without user lookup
    console.warn('[RAGFlow] Could not list users:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Register a new user in RAGFlow
// ─────────────────────────────────────────────────────────────────────────────
const generatePassword = () => {
  return crypto.randomBytes(9).toString('base64').slice(0, 12).replace(/[+/=]/g, 'X');
};

export const registerUser = async (email, nickname) => {
  const plainPassword = generatePassword();
  const encPsw = encryptPassword(plainPassword);

  const res = await fetch(`${BASE}/api/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      nickname: nickname || email.split('@')[0],
      password: encPsw,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'RAGFlow registration failed');

  console.log(`[RAGFlow] Registered new user: ${email}`);
  return { ...data.data, plainPassword };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Main: Provision user after successful payment
//
//  Calls /api/v1/system/provision which updates plan_type + plan_expiry_date
//  in the RAGFlow database without touching the user's active session.
// ─────────────────────────────────────────────────────────────────────────────
export const provisionUser = async ({ email, plan, months, expiryDate, license_name }) => {
  if (process.env.NODE_ENV !== 'production' && process.env.ATMOS_MOCK === 'true' && (!BASE || BASE.includes('localhost:3096') || BASE.includes('mock') || !process.env.RAGFLOW_API_KEY)) {
    console.log(`[RAGFlow MOCK] ✅ Mock provisioned plan="${plan}" for ${email}`);
    return {
      success: true,
      email,
      plan,
      months,
      expiryDate,
      licenseKey: plan && plan.includes('license') ? `SWIPIES-ACT-MOCK-${Date.now()}` : null,
      ragflowUrl: BASE || 'http://localhost:9380',
    };
  }

  const adminToken = await getAdminToken();

  // ── Step 1: Provision the plan in RAGFlow DB ──
  console.log(`[RAGFlow] Provisioning plan="${plan}" months=${months} for ${email}`);

  const provRes = await fetch(`${BASE}/api/v1/system/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: adminToken,
    },
    body: JSON.stringify({
      email,
      plan,
      months,
      license_name: license_name || undefined,
    }),
  });

  let provData;
  try {
    provData = await provRes.json();
  } catch {
    const raw = await provRes.text();
    throw new Error(`RAGFlow provision returned non-JSON (${provRes.status}): ${raw.slice(0, 200)}`);
  }

  if (!provRes.ok || provData.code !== 0) {
    throw new Error(provData.message || `Provisioning failed (HTTP ${provRes.status})`);
  }

  console.log(`[RAGFlow] ✅ Plan "${plan}" provisioned for ${email}`);

  return {
    success: true,
    email,
    plan,
    months,
    expiryDate,
    licenseKey: provData.data?.license_key || null,
    ragflowUrl: BASE,
  };
};


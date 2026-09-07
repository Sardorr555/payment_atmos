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

const candidateBases = [
  process.env.RAGFLOW_INTERNAL_URL,
  'http://127.0.0.1:9222',
  'http://127.0.0.1:9380',
  'http://localhost:9222',
  'http://localhost:9380',
  process.env.RAGFLOW_BASE_URL,
  'https://app.swipies.app',
].filter(Boolean);

export const fetchRagflow = async (path, options = {}) => {
  let lastErr = null;
  for (const b of candidateBases) {
    const cleanBase = b.replace(/\/+$/, '').replace(/^https?:\/\/swipies\.app(?::\d+)?$/, 'https://app.swipies.app');
    const url = `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
    try {
      const res = await fetch(url, options);
      if (res.status === 403 || res.status === 503) {
        const text = await res.clone().text().catch(() => '');
        if (text.includes('Just a moment...') || text.includes('cf-chl')) {
          console.warn(`[RAGFlow Fetch] ${url} hit Cloudflare challenge, skipping to next internal base...`);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to reach RAGFlow at ${path}`);
};

const BASE = 'http://127.0.0.1:9222';

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
  const apiKey = process.env.RAGFLOW_API_KEY || 'swipies_system_secret_key_2026';
  if (apiKey) {
    return apiKey;
  }

  // ── Option 2: email/password session login fallback ──
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken;

  const email = process.env.RAGFLOW_ADMIN_EMAIL;
  const password = process.env.RAGFLOW_ADMIN_PASSWORD;

  if (email && password) {
    try {
      const encPsw = encryptPassword(password);
      const res = await fetchRagflow('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: encPsw }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.code === 0 && data.data?.token) {
          _adminToken = data.data.token;
          _adminTokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
          console.log('[RAGFlow] Admin session refreshed via email/password login');
          return _adminToken;
        }
      }
    } catch (err) {
      console.warn('[RAGFlow Login Fallback]', err.message);
    }
  }

  return 'swipies_system_secret_key_2026';
};

// ─────────────────────────────────────────────────────────────────────────────
//  Get all users (admin endpoint on port 9381 via /api/v1/admin/users)
// ─────────────────────────────────────────────────────────────────────────────
export const listUsers = async () => {
  const token = await getAdminToken();

  const res = await fetchRagflow('/api/v1/admin/users', {
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

  const res = await fetchRagflow('/api/v1/users', {
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

  const provRes = await fetchRagflow('/api/v1/system/provision', {
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

// ─────────────────────────────────────────────────────────────────────────────
//  Payment Ledger integration: init, finalize, fail
// ─────────────────────────────────────────────────────────────────────────────
export const initPaymentTransaction = async ({ transaction_id, email, plan, months, payment_method }) => {
  if (process.env.NODE_ENV !== 'production' && process.env.ATMOS_MOCK === 'true' && (!BASE || BASE.includes('mock') || !process.env.RAGFLOW_API_KEY)) {
    return { success: true, mock: true };
  }

  const adminToken = await getAdminToken();
  const authHeader = adminToken.startsWith('Bearer ') ? adminToken : `Bearer ${adminToken}`;

  const res = await fetchRagflow('/api/v1/system/payment/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      transaction_id,
      email,
      plan,
      months,
      payment_method: payment_method || 'atmos_uzcard_humo',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    console.warn(`[RAGFlow Ledger] Payment init failed for tx=${transaction_id}:`, data.message || res.statusText);
  }
  return data;
};

export const finalizePaymentTransaction = async ({ transaction_id, email, plan, months, license_name, gateway_response }) => {
  if (process.env.NODE_ENV !== 'production' && process.env.ATMOS_MOCK === 'true' && (!BASE || BASE.includes('mock') || !process.env.RAGFLOW_API_KEY)) {
    console.log(`[RAGFlow MOCK] ✅ Finalized mock transaction ${transaction_id}`);
    return {
      success: true,
      email,
      plan,
      months,
      licenseKey: plan && plan.includes('license') ? `SWIPIES-ACT-MOCK-${Date.now()}` : null,
      ragflowUrl: BASE || 'http://localhost:9380',
    };
  }

  const adminToken = await getAdminToken();
  const authHeader = adminToken.startsWith('Bearer ') ? adminToken : `Bearer ${adminToken}`;

  console.log(`[RAGFlow System API] Finalizing transaction_id="${transaction_id}" plan="${plan}" months=${months} for ${email}`);

  try {
    const res = await fetchRagflow('/api/v1/system/payment/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({
        transaction_id,
        email,
        plan,
        months,
        license_name: license_name || undefined,
        gateway_response: gateway_response || undefined,
      }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      const raw = await res.text();
      throw new Error(`RAGFlow finalize returned non-JSON (${res.status}): ${raw.slice(0, 200)}`);
    }

    if (res.ok && data.code === 0) {
      console.log(`[RAGFlow System API] ✅ Transaction "${transaction_id}" successfully verified and provisioned for ${email}`);
      return {
        success: true,
        email,
        plan,
        months,
        paid_amount_uzs: data.data?.paid_amount_uzs,
        licenseKey: data.data?.license_key || null,
        ragflowUrl: BASE,
      };
    } else {
      console.warn(`[RAGFlow System API] Ledger finalize returned error (${data?.message || res.statusText}). Falling back to direct provisionUser...`);
    }
  } catch (err) {
    console.warn(`[RAGFlow System API] Ledger finalize call failed (${err.message}). Falling back to direct provisionUser...`);
  }

  // Guaranteed fallback: call /api/v1/system/provision directly so user is always provisioned
  console.log(`[RAGFlow System API] Calling provisionUser fallback for ${email} (plan=${plan}, months=${months})`);
  const fallbackResult = await provisionUser({
    email,
    plan,
    months: Number(months || 1),
    license_name,
  });
  console.log(`[RAGFlow System API] ✅ User ${email} provisioned successfully via provisionUser fallback`);
  return fallbackResult;
};

export const failPaymentTransaction = async ({ transaction_id, error_code, error_message, gateway_response }) => {
  if (process.env.NODE_ENV !== 'production' && process.env.ATMOS_MOCK === 'true' && (!BASE || BASE.includes('mock') || !process.env.RAGFLOW_API_KEY)) {
    return { success: true };
  }

  const adminToken = await getAdminToken();
  const authHeader = adminToken.startsWith('Bearer ') ? adminToken : `Bearer ${adminToken}`;

  const res = await fetchRagflow('/api/v1/system/payment/fail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      transaction_id,
      error_code,
      error_message,
      gateway_response,
    }),
  });

  const data = await res.json().catch(() => ({}));
  return data;
};


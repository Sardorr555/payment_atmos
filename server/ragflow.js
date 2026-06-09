/**
 * ragflow.js — RAGFlow user provisioning service
 *
 * Handles:
 *  - Admin login → session token
 *  - Password RSA encryption (required by RAGFlow)
 *  - User registration (if not exists)
 *  - User lookup by email
 *  - Subscription status update via user nickname/metadata
 */

import crypto from 'crypto';
import fs from 'fs';
import fetch from 'node-fetch';

const BASE = process.env.RAGFLOW_BASE_URL; // e.g. https://swipies.app

// ─────────────────────────────────────────────────────────────────────────────
//  RSA Password encryption (RAGFlow requires this for login & register)
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
  // Step 1: base64-encode the plain password
  const b64Password = Buffer.from(plainPassword, 'utf-8').toString('base64');
  // Step 2: RSA-encrypt with PKCS1 padding
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(b64Password, 'utf-8')
  );
  // Step 3: base64-encode the result
  return encrypted.toString('base64');
};

// ─────────────────────────────────────────────────────────────────────────────
//  Admin session (cached, refreshed on expiry)
// ─────────────────────────────────────────────────────────────────────────────
let _adminToken = null;
let _adminTokenExpiry = 0;

const getAdminToken = async () => {
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken;

  const email = process.env.RAGFLOW_ADMIN_EMAIL;
  const password = process.env.RAGFLOW_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('RAGFLOW_ADMIN_EMAIL and RAGFLOW_ADMIN_PASSWORD must be set in server/.env');
  }

  const encPsw = encryptPassword(password);

  const res = await fetch(`${BASE}/v1/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: encPsw }),
  });

  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`RAGFlow admin login failed: ${data.message}`);
  }

  // Token is valid for ~24h; refresh every 20h to be safe
  _adminToken = data.data.token;
  _adminTokenExpiry = Date.now() + 20 * 60 * 60 * 1000;

  console.log('[RAGFlow] Admin session refreshed');
  return _adminToken;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Get all users (admin endpoint)
// ─────────────────────────────────────────────────────────────────────────────
export const listUsers = async () => {
  const token = await getAdminToken();

  const res = await fetch(`${BASE}/api/v1/admin/users`, {
    headers: { Authorization: token },
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(data.message || 'Failed to list RAGFlow users');
  return data.data || [];
};

// ─────────────────────────────────────────────────────────────────────────────
//  Find user by email
// ─────────────────────────────────────────────────────────────────────────────
export const findUserByEmail = async (email) => {
  const users = await listUsers();
  return users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Register a new user in RAGFlow
// ─────────────────────────────────────────────────────────────────────────────
const generatePassword = () => {
  // 12-char random password: letters + digits
  return crypto.randomBytes(9).toString('base64').slice(0, 12).replace(/[+/=]/g, 'X');
};

export const registerUser = async (email, nickname) => {
  const plainPassword = generatePassword();
  const encPsw = encryptPassword(plainPassword);

  const res = await fetch(`${BASE}/v1/user/register`, {
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
  return { ...data.data, plainPassword }; // return generated password so we can email it
};

// ─────────────────────────────────────────────────────────────────────────────
//  Main: Provision user after payment
//  - If user exists → update nickname with plan info (activation signal)
//  - If user doesn't exist → register them + return temp password
// ─────────────────────────────────────────────────────────────────────────────
export const provisionUser = async ({ email, plan, months, expiryDate }) => {
  let user = await findUserByEmail(email);
  let isNewUser = false;
  let tempPassword = null;

  if (!user) {
    // Register new user
    const result = await registerUser(email, email.split('@')[0]);
    tempPassword = result.plainPassword;
    user = result;
    isNewUser = true;
    console.log(`[RAGFlow] New user created for ${email}`);
  } else {
    console.log(`[RAGFlow] Existing user found for ${email} — activating subscription`);
  }

  return {
    isNewUser,
    tempPassword,       // only set for new users — should be emailed to them
    userId: user?.id,
    email,
    plan,
    months,
    expiryDate,
    ragflowUrl: BASE,
  };
};

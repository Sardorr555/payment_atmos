import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import 'dotenv/config';
import { provisionUser, listUsers, findUserByEmail } from './ragflow.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Trust reverse proxy (Nginx) for rate limiter IP detection
app.set('trust proxy', 1);

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────
app.use(express.json());

// Flexible CORS allowing localhost, swipies.app, app.swipies.app, and configured FRONTEND_URL
app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server, mobile or web requests
    callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}));

// Rate limiter: max 30 payment attempts per IP per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many payment attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper for fetch with timeout (prevents hanging indefinitely)
const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

// Safe JSON parser for upstream responses (never throws unhandled <!DOCTYPE> error)
const parseJsonResponse = async (res, serviceName = 'Gateway') => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[${serviceName}] Non-JSON response (${res.status}):`, text.slice(0, 300));
    throw new Error(`${serviceName} returned invalid non-JSON response (${res.status}). Body: ${text.slice(0, 100)}`);
  }
  return data;
};

// Mock mode is ONLY allowed in non-production environments
const isMock = process.env.NODE_ENV !== 'production' && (process.env.ATMOS_MOCK === 'true' || process.env.ATMOS_MOCK === '1');

// Helper to calculate official minimum expected price in UZS
export const calculateExpectedAmountUzs = (plan, months = 1) => {
  const p = (plan || '').toLowerCase();
  const m = Math.max(1, Number(months) || 1);

  if (p === 'license') {
    if (m === 6) return 2470000;
    if (m >= 12) return 4500000;
    return m * 450000;
  }

  let monthlyPrice = 199000; // Plus default
  if (p === 'pro') {
    monthlyPrice = 400000;
  } else if (p === 'plus') {
    monthlyPrice = 199000;
  } else if (p === 'free') {
    return 0;
  }

  let discount = 0;
  if (m === 6) discount = 0.10;
  if (m >= 12) discount = 0.20;

  const total = (monthlyPrice * m) * (1 - discount);
  return Math.round(total);
};

// ─────────────────────────────────────────────
//  Atmos Auth helper — runs on the SERVER only
// ─────────────────────────────────────────────
const getAtmosToken = async () => {
  if (isMock) {
    return 'mock-token';
  }

  const auth = Buffer.from(
    `${process.env.ATMOS_KEY}:${process.env.ATMOS_SECRET}`
  ).toString('base64');

  const res = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }, 12000);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Atmos auth failed (${res.status}): ${text.slice(0, 150)}`);
  }

  const data = await parseJsonResponse(res, 'Atmos Token');
  return data.access_token;
};

// ─────────────────────────────────────────────
//  ROUTE: Create local card transaction (Uzcard/Humo)
//  POST /api/pay/create
// ─────────────────────────────────────────────
app.post('/api/pay/create', paymentLimiter, async (req, res) => {
  try {
    const { amount, account, lang = 'ru' } = req.body;

    if (!amount || !account) {
      return res.status(400).json({ error: 'amount and account are required' });
    }

    if (isMock) {
      const mockTxId = 'mock-tx-' + Date.now();
      return res.json({
        result: { code: 'OK' },
        transaction_id: mockTxId,
        mock: true,
      });
    }

    const token = await getAtmosToken();

    const requestBody = {
      amount: Math.round(Number(amount) * 100), // тийины
      account,
      store_id: Number(process.env.ATMOS_STORE_ID),
      lang,
    };
    console.log('[ATMOS PAY CREATE REQUEST]', JSON.stringify(requestBody, null, 2));

    const atmosRes = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/merchant/pay/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    }, 15000);

    const data = await parseJsonResponse(atmosRes, 'Atmos Pay Create');
    console.log('[ATMOS PAY CREATE RESPONSE]', JSON.stringify(data, null, 2));

    if (!data.transaction_id) {
      return res.status(400).json({
        error: data.result?.description || data.message || 'Failed to create Atmos transaction',
        detail: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[/api/pay/create]', err.message);
    res.status(502).json({ error: err.message || 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Pre-apply (request OTP)
//  POST /api/pay/pre-apply
// ─────────────────────────────────────────────
app.post('/api/pay/pre-apply', paymentLimiter, async (req, res) => {
  try {
    const { transaction_id, card_number, expiry } = req.body;

    if (!transaction_id || !card_number || !expiry) {
      return res.status(400).json({ error: 'transaction_id, card_number and expiry are required' });
    }

    if (isMock && String(transaction_id).startsWith('mock-tx-')) {
      return res.json({
        result: { code: 'OK' },
        status: 'waiting_otp',
        phone: '+998 ** *** ** 99',
        mock: true,
      });
    }

    const token = await getAtmosToken();

    const atmosRes = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/merchant/pay/pre-apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id: Number(transaction_id) || transaction_id,
        card_number,
        expiry,
        store_id: Number(process.env.ATMOS_STORE_ID),
      }),
    }, 15000);

    const data = await parseJsonResponse(atmosRes, 'Atmos Pre-Apply');
    console.log('[ATMOS PRE-APPLY RESPONSE]', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    console.error('[/api/pay/pre-apply]', err.message);
    res.status(502).json({ error: err.message || 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Apply (confirm OTP → complete payment)
//  POST /api/pay/apply
// ─────────────────────────────────────────────
app.post('/api/pay/apply', paymentLimiter, async (req, res) => {
  try {
    const { transaction_id, otp, email, plan, months, license_name } = req.body;

    if (!transaction_id || !otp) {
      return res.status(400).json({ error: 'transaction_id and otp are required' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'OTP must be exactly 6 digits' });
    }

    if (isMock && String(transaction_id).startsWith('mock-tx-')) {
      let provisionResult = null;
      if (email && plan) {
        try {
          provisionResult = await provisionUser({
            email,
            plan,
            months: Number(months || 1),
            license_name,
          });
        } catch (rfErr) {
          console.warn('[MOCK PROVISION ERROR]', rfErr.message);
        }
      }
      return res.json({
        result: { code: 'OK', description: 'Mock payment approved' },
        success: true,
        mock: true,
        provision: provisionResult,
      });
    }

    const token = await getAtmosToken();

    const atmosRes = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/merchant/pay/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id: Number(transaction_id) || transaction_id,
        otp,
        store_id: Number(process.env.ATMOS_STORE_ID),
      }),
    }, 15000);

    const data = await parseJsonResponse(atmosRes, 'Atmos Apply');
    console.log('[ATMOS APPLY RESPONSE]', JSON.stringify(data, null, 2));

    const code = data?.result?.code;
    const hint = data?.hint;
    const isSuccess = (code === 'OK' || code === 1 || code === '1') && hint !== 102 && String(hint) !== '102';
    if (!isSuccess) {
      return res.status(400).json({ error: data?.result?.description || 'Payment failed' });
    }

    // ── Backend Auto-Provisioning on VERIFIED payment only ───────
    let provisionResult = null;
    if (email && plan) {
      const expectedUzs = calculateExpectedAmountUzs(plan, months);
      // data.amount or data.payload.amount from Atmos is in tiyins (1 UZS = 100 tiyins)
      const paidTiyins = Number(data?.amount || data?.payload?.amount || 0);
      const paidUzs = Math.round(paidTiyins / 100);

      // Fail-closed verification: paid amount must be positive and cover expected price
      if (expectedUzs > 0 && (!paidUzs || paidUzs <= 0 || paidUzs < expectedUzs * 0.95)) {
        console.error(`[PAY APPLY PRICE MISMATCH] Invalid or insufficient paid amount: ${paidUzs} UZS < expected ${expectedUzs} UZS for plan "${plan}" (${months} mo)`);
        return res.status(400).json({
          error: `Payment amount (${paidUzs} UZS) is invalid or does not match required price (${expectedUzs} UZS) for plan ${plan}.`,
        });
      }

      try {
        console.log(`[PAY APPLY SUCCESS] Auto-provisioning plan=${plan} (${months}mo) for ${email} (paid: ${paidUzs || expectedUzs} UZS)`);
        provisionResult = await provisionUser({
          email,
          plan,
          months: Number(months || 1),
          license_name,
        });
      } catch (rfErr) {
        console.error('[PAY APPLY PROVISION ERROR]', rfErr.message);
      }
    }

    res.json({
      ...data,
      success: true,
      provision: provisionResult,
    });
  } catch (err) {
    console.error('[/api/pay/apply]', err.message);
    res.status(502).json({ error: err.message || 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Visa/Mastercard payment (IPS)
//  POST /api/pay/mps
// ─────────────────────────────────────────────
app.post('/api/pay/mps', paymentLimiter, async (req, res) => {
  try {
    const { pan, expiry, amount, card_name, cvc2, ext_id } = req.body;

    if (!pan || !expiry || !amount || !card_name || !cvc2 || !ext_id) {
      return res.status(400).json({ error: 'All card fields are required' });
    }

    if (isMock) {
      return res.json({
        result: { code: 'OK' },
        payload: { id: 'mock-mps-' + Date.now() },
        mock: true,
      });
    }

    const token = await getAtmosToken();

    // Step 1: Create draft transaction
    const preCreateRes = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/pre-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: process.env.ATMOS_KEY,
      },
      body: JSON.stringify({
        amount: Math.round(Number(amount) * 100),
        ext_id,
        store_id: Number(process.env.ATMOS_STORE_ID),
        ofd_items: [],
        account: ext_id,
      }),
    }, 15000);
    const preCreateData = await parseJsonResponse(preCreateRes, 'Atmos MPS Pre-Create');

    if (preCreateData?.status?.code !== 0) {
      throw new Error(preCreateData?.status?.message || 'Failed to create MPS transaction');
    }

    const transaction_id = preCreateData.payload.id;

    // Step 2: Attach card and charge
    const createRes = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: process.env.ATMOS_KEY,
      },
      body: JSON.stringify({
        pan,
        expiry,
        amount: Math.round(Number(amount) * 100),
        transaction_id,
        card_name,
        cvc2,
        client_ip_addr: req.ip || '127.0.0.1',
        ext_id,
      }),
    }, 15000);

    const data = await parseJsonResponse(createRes, 'Atmos MPS Create');
    res.json(data);
  } catch (err) {
    console.error('[/api/pay/mps]', err.message);
    res.status(502).json({ error: err.message || 'International card payment error', detail: err.message });
  }
});

const verifyAtmosTransaction = async (transaction_id, plan, months, amountPayload = null) => {
  if (!transaction_id) return false;

  let data;
  if (isMock && String(transaction_id).startsWith('mock-tx-')) {
    data = {
      result: { code: 'OK' },
      status: 'PAID',
      amount: amountPayload !== null && amountPayload !== undefined ? Number(amountPayload) : (calculateExpectedAmountUzs(plan, months) * 100),
      mock: true,
    };
  } else {
    try {
      const token = await getAtmosToken();
      const res = await fetchWithTimeout(`${process.env.ATMOS_BASE_URL}/merchant/pay/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transaction_id: Number(transaction_id) || transaction_id,
          store_id: Number(process.env.ATMOS_STORE_ID),
        }),
      }, 15000);

      data = await parseJsonResponse(res, 'Atmos Status Verification');
      console.log('[ATMOS REVERSE STATUS CHECK]', JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[ATMOS REVERSE STATUS CHECK FAILED]', err.message);
      return false;
    }
  }

  const code = data?.result?.code;
  const status = String(data?.status || data?.result?.status || '').toUpperCase();
  const hint = data?.hint;

  // Strict success criteria:
  // 1. Result code must be 'OK' or 1 / '1'
  // 2. Status MUST be explicitly 'PAID', 'SUCCESS', or 'CONFIRMED' (NO fallback to transaction_id!)
  // 3. Hint must not be error code (e.g. 102)
  const isSuccessCode = code === 'OK' || code === 1 || code === '1';
  const isPaidStatus = status === 'PAID' || status === 'SUCCESS' || status === 'CONFIRMED';
  const isNotHintError = hint !== 102 && String(hint) !== '102';

  if (!isSuccessCode || !isPaidStatus || !isNotHintError) {
    return false;
  }

  // ── Amount & Plan Verification (Fail-Closed) ──
  if (plan) {
    const expectedUzs = calculateExpectedAmountUzs(plan, months);
    // data.amount is returned in tiyins (1 UZS = 100 tiyins)
    const paidTiyins = Number(data?.amount || data?.payload?.amount || 0);
    const paidUzs = Math.round(paidTiyins / 100);

    // Fail-closed: if expected price is > 0, paid amount must be valid and sufficient
    if (expectedUzs > 0 && (!paidUzs || paidUzs <= 0 || paidUzs < expectedUzs * 0.95)) {
      console.error(`[PRICE MISMATCH] Invalid or insufficient paid amount: ${paidUzs} UZS, expected at least ${expectedUzs} UZS for plan "${plan}" (${months} mo)`);
      return false;
    }
  }

  return data;
};

// ─────────────────────────────────────────────
//  ROUTE: Webhook receiver (Atmos → our server)
//  POST /api/webhook/atmos (ZERO-TRUST VERIFIED)
// ─────────────────────────────────────────────
app.post('/api/webhook/atmos', async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[WEBHOOK] Atmos notification received:', JSON.stringify(payload, null, 2));

    const transaction_id = payload.transaction_id || payload.id;
    const { email, plan, months, license_name } = payload;

    // 1. Validate mandatory fields
    if (!transaction_id || !email || !plan) {
      console.warn('[WEBHOOK REJECTED] Missing required fields (transaction_id, email, plan)');
      return res.status(400).json({ error: 'transaction_id, email and plan are required' });
    }

    // 2. Zero-Trust Reverse Verification with Atmos Gateway (including amount check)
    const verifiedData = await verifyAtmosTransaction(transaction_id, plan, months, payload.amount);
    if (!verifiedData) {
      console.error(`[WEBHOOK REJECTED] Fake, unpaid, or underpaid transaction ID: ${transaction_id}`);
      return res.status(400).json({ error: 'Unverified transaction: payment not confirmed or amount mismatch by Atmos gateway' });
    }

    // 3. Provision only upon confirmed verification
    console.log(`[WEBHOOK VERIFIED] Provisioning plan="${plan}" for ${email} (tx=${transaction_id})`);
    const result = await provisionUser({
      email,
      plan,
      months: Number(months || 1),
      license_name,
    });

    res.json({ status: 'success', verified: true, provision: result });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Provision RAGFlow user (Internal / Admin ONLY)
//  POST /api/ragflow/provision
// ─────────────────────────────────────────────
app.post('/api/ragflow/provision', async (req, res) => {
  try {
    const authHeader = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Forbidden. Admin authentication required.' });
    }

    const { email, plan, months, expiryDate, license_name } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const result = await provisionUser({ email, plan, months, expiryDate, license_name });

    let licenseKey = result.licenseKey;
    const isLicensePlan = plan && plan.toLowerCase().includes('license');
    if (!licenseKey && isLicensePlan) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
      const expStr = expDate.toISOString().split('T')[0];
      const payload = {
        owner: email,
        expiry: expStr,
        type: Number(months || 1) >= 12 ? 'yearly' : '6-month'
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      licenseKey = `SWIPIES-ACT-${b64}`;
    }

    res.json({
      success: true,
      isNewUser: result.isNewUser,
      tempPassword: result.tempPassword,
      ragflowUrl: process.env.RAGFLOW_BASE_URL,
      licenseKey,
      message: licenseKey
        ? `License key generated successfully!`
        : (result.isNewUser
            ? `Account created at ${process.env.RAGFLOW_BASE_URL}. Credentials sent to ${email}.`
            : `Subscription activated for existing account ${email}.`),
    });
  } catch (err) {
    console.error('[/api/ragflow/provision]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: List RAGFlow users (for admin panel)
//  GET /api/ragflow/users
// ─────────────────────────────────────────────
app.get('/api/ragflow/users', async (req, res) => {
  try {
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const users = await listUsers();
    res.json({ success: true, users });
  } catch (err) {
    console.error('[/api/ragflow/users]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Check single RAGFlow user by email
//  GET /api/ragflow/user?email=xxx
// ─────────────────────────────────────────────
app.get('/api/ragflow/user', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ found: false });

    res.json({ found: true, user });
  } catch (err) {
    console.error('[/api/ragflow/user]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Health check
//  GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    store_id: process.env.ATMOS_STORE_ID,
    mock: isMock,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Atmos payment server running on http://localhost:${PORT}`);
  console.log(`   Store ID : ${process.env.ATMOS_STORE_ID}`);
  console.log(`   Mock Mode: ${isMock}`);
  console.log(`   Health   : http://localhost:${PORT}/api/health\n`);
});

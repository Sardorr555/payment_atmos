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

// Allow requests only from our frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST'],
}));

// Rate limiter: max 10 payment attempts per IP per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

process.env.ATMOS_KEY = process.env.ATMOS_KEY || 'TpLRLagJ1SXiZ0dT_om5BT_I3Nga';
process.env.ATMOS_SECRET = process.env.ATMOS_SECRET || 'bMH7gjat2EgI3fTXoLJX7CRUcbAa';
process.env.ATMOS_STORE_ID = process.env.ATMOS_STORE_ID || '100506';

const defaultAtmosUrl = 'https://apigw.atmos.uz';
process.env.ATMOS_BASE_URL = process.env.ATMOS_BASE_URL || defaultAtmosUrl;

const isMockMode = process.env.MOCK_PAYMENT === 'true' || 
                   !process.env.ATMOS_KEY || 
                   process.env.ATMOS_KEY.includes('YOUR_') || 
                   !process.env.ATMOS_SECRET;

function maskCard(card) {
  if (!card) return '****';
  const clean = String(card).replace(/\s/g, '');
  if (clean.length < 10) return '****';
  return clean.substring(0, 6) + '******' + clean.substring(clean.length - 4);
}

function normalizeExpiry(expiry) {
  if (!expiry) return '';
  const clean = String(expiry).replace(/[^0-9]/g, '');
  if (clean.length === 4) {
    const firstTwo = parseInt(clean.substring(0, 2), 10);
    const lastTwo = parseInt(clean.substring(2, 4), 10);
    // If MMYY format (e.g. 1228 where month is 12 <= 12 and year is 28 > 12) -> convert to YYMM
    if (firstTwo <= 12 && lastTwo > 12) {
      return clean.substring(2, 4) + clean.substring(0, 2);
    }
  }
  return clean;
}

function analyzeAtmosError(data) {
  if (!data) return null;
  const code = data?.result?.code ?? data?.code;
  const hint = data?.hint;
  const desc = data?.result?.description ?? data?.message ?? data?.description ?? '';

  const is102 = code === 102 || hint === 102 || 
                String(code).includes('102') || 
                String(hint).includes('102') || 
                String(desc).includes('102');

  if (is102) {
    return {
      is102: true,
      code: 102,
      hint: hint || 102,
      message: 'SMS gateway error (code 102 / hint 102): SMS was not sent. Ensure SMS notifications are active on the Uzcard/Humo card, or that the merchant has SMS balance.',
      messageRu: 'Ошибка СМС-шлюза (код 102 / hint 102): СМС с кодом не отправлено. Убедитесь, что на карте Uzcard/Humo подключена услуга СМС-информирования (в мобильном приложении банка или банкомате), либо проверьте баланс СМС мерчанта.'
    };
  }

  return {
    is102: false,
    code,
    hint,
    message: desc || 'Atmos API returned an error response.',
    messageRu: desc || 'Ошибка проведения платежа через Atmos.'
  };
}

console.log(`\n==================================================`);
console.log(`[ATMOS INTEGRATION SERVER STARTED]`);
console.log(`  Mock Mode   : ${isMockMode}`);
console.log(`  Base URL    : ${process.env.ATMOS_BASE_URL}`);
console.log(`  Store ID    : ${process.env.ATMOS_STORE_ID}`);
console.log(`==================================================\n`);

// ─────────────────────────────────────────────
//  Atmos Auth helper — runs on the SERVER only
// ─────────────────────────────────────────────
const getAtmosToken = async () => {
  if (isMockMode) {
    return 'mock-token';
  }

  const auth = Buffer.from(
    `${process.env.ATMOS_KEY}:${process.env.ATMOS_SECRET}`
  ).toString('base64');

  console.log(`[ATMOS AUTH] Requesting token from ${process.env.ATMOS_BASE_URL}/token`);

  const res = await fetch(`${process.env.ATMOS_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[ATMOS AUTH FAILED] Status: ${res.status}, Body: ${errText}`);
    throw new Error(`Atmos auth failed with status ${res.status}: ${errText}`);
  }

  const data = await res.json();
  console.log(`[ATMOS AUTH SUCCESS] Token obtained (expires in: ${data.expires_in || 'N/A'}s)`);
  return data.access_token;
};

// ─────────────────────────────────────────────
//  ROUTE: Create local card transaction (Uzcard/Humo)
//  POST /api/pay/create
// ─────────────────────────────────────────────
app.post('/api/pay/create', paymentLimiter, async (req, res) => {
  const reqTime = new Date().toISOString();
  try {
    const { amount, account, lang = 'ru' } = req.body;

    console.log(`\n==================================================`);
    console.log(`[ATMOS PAY CREATE REQUEST] ${reqTime}`);
    console.log(`  Amount   : ${amount} UZS (${Math.round(Number(amount) * 100)} tiyins)`);
    console.log(`  Account  : ${account}`);
    console.log(`  Lang     : ${lang}`);
    console.log(`  Client IP: ${req.ip}`);

    if (!amount || !account) {
      console.log(`[ATMOS PAY CREATE ERROR] Missing amount or account`);
      return res.status(400).json({ error: 'Укажите сумму и Email адрес' });
    }

    const cleanAccount = String(account).trim();
    if (!cleanAccount.includes('@') || cleanAccount.length < 5) {
      console.log(`[ATMOS PAY CREATE ERROR] Invalid account email: ${cleanAccount}`);
      return res.status(400).json({ error: 'Укажите корректный Email адрес (например, user@example.com)' });
    }

    if (isMockMode) {
      const mockTx = {
        transaction_id: 'mock-tx-' + Math.random().toString(36).substr(2, 9),
        amount: amount,
        mock: true
      };
      console.log('[MOCK ATMOS PAY CREATE RESPONSE]', JSON.stringify(mockTx, null, 2));
      return res.json(mockTx);
    }

    const token = await getAtmosToken();

    const requestBody = {
      amount: Math.round(Number(amount) * 100), // тийины
      account: String(account),
      store_id: String(process.env.ATMOS_STORE_ID),
      lang,
    };
    console.log('[ATMOS PAY CREATE API PAYLOAD]', JSON.stringify(requestBody, null, 2));

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await atmosRes.json();
    console.log(`[ATMOS PAY CREATE API RESPONSE] Status: ${atmosRes.status}`);
    console.log(JSON.stringify(data, null, 2));

    const errInfo = analyzeAtmosError(data);

    if (!data.transaction_id) {
      const errorMsg = errInfo?.messageRu || errInfo?.message || data.result?.description || 'Failed to create Atmos transaction';
      console.error(`[ATMOS PAY CREATE FAILED] ${errorMsg}`);
      return res.status(400).json({
        error: errorMsg,
        hint: data.hint || (errInfo?.is102 ? 102 : undefined),
        detail: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[ATMOS PAY CREATE EXCEPTION]', err);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Pre-apply (request OTP)
//  POST /api/pay/pre-apply
// ─────────────────────────────────────────────
app.post('/api/pay/pre-apply', paymentLimiter, async (req, res) => {
  const reqTime = new Date().toISOString();
  try {
    const { transaction_id, card_number, expiry } = req.body;

    console.log(`\n==================================================`);
    console.log(`[ATMOS PRE-APPLY REQUEST] ${reqTime}`);
    console.log(`  Transaction ID : ${transaction_id}`);
    console.log(`  Card Number    : ${maskCard(card_number)}`);
    console.log(`  Raw Expiry     : ${expiry}`);

    if (!transaction_id || !card_number || !expiry) {
      return res.status(400).json({ error: 'transaction_id, card_number and expiry are required' });
    }

    if (isMockMode || (transaction_id && String(transaction_id).startsWith('mock-tx-'))) {
      const mockPre = {
        status: 'waiting_otp',
        phone: '+998 90 *** ** 99',
        phone_number: '+998 90 *** ** 99',
        mock: true
      };
      console.log('[MOCK ATMOS PRE-APPLY RESPONSE]', JSON.stringify(mockPre, null, 2));
      return res.json(mockPre);
    }

    const token = await getAtmosToken();
    const normalizedExpiry = normalizeExpiry(expiry);
    const cleanCard = String(card_number).replace(/\s/g, '');

    const payload = {
      transaction_id: Number(transaction_id),
      card_number: cleanCard,
      expiry: normalizedExpiry,
      store_id: String(process.env.ATMOS_STORE_ID),
    };

    console.log('[ATMOS PRE-APPLY API PAYLOAD]', JSON.stringify({
      ...payload,
      card_number: maskCard(cleanCard)
    }, null, 2));

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/pre-apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await atmosRes.json();
    console.log(`[ATMOS PRE-APPLY API RESPONSE] Status: ${atmosRes.status}`);
    console.log(JSON.stringify(data, null, 2));

    const errInfo = analyzeAtmosError(data);

    const resCode = data?.result?.code ?? data?.code;
    const isSuccess = (resCode === 'OK' || resCode === 1 || resCode === 0) || 
                      (!resCode && data?.status === 'waiting_otp') ||
                      (!data?.result?.code && !data?.code && atmosRes.ok && !errInfo?.is102);

    if (!isSuccess || errInfo?.is102) {
      const errorMsg = errInfo?.messageRu || errInfo?.message || data?.result?.description || 'Card validation/OTP request failed';
      console.error(`[ATMOS PRE-APPLY FAILED] Hint/Code: ${data?.hint || resCode} -> ${errorMsg}`);
      return res.status(400).json({
        error: errorMsg,
        hint: data?.hint || (errInfo?.is102 ? 102 : undefined),
        detail: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[ATMOS PRE-APPLY EXCEPTION]', err);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Apply (confirm OTP → complete payment)
//  POST /api/pay/apply
// ─────────────────────────────────────────────
app.post('/api/pay/apply', paymentLimiter, async (req, res) => {
  const reqTime = new Date().toISOString();
  try {
    const { transaction_id, otp } = req.body;

    console.log(`\n==================================================`);
    console.log(`[ATMOS APPLY REQUEST] ${reqTime}`);
    console.log(`  Transaction ID : ${transaction_id}`);
    console.log(`  OTP            : ${otp ? '******' : 'N/A'}`);

    if (!transaction_id || !otp) {
      return res.status(400).json({ error: 'transaction_id and otp are required' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'OTP must be exactly 6 digits' });
    }

    if (isMockMode || (transaction_id && String(transaction_id).startsWith('mock-tx-'))) {
      const mockApply = {
        result: {
          code: 'OK',
          description: 'Success'
        },
        mock: true
      };
      console.log('[MOCK ATMOS APPLY RESPONSE]', JSON.stringify(mockApply, null, 2));
      return res.json(mockApply);
    }

    const token = await getAtmosToken();

    const payload = {
      transaction_id: Number(transaction_id),
      otp: String(otp).trim(),
      store_id: String(process.env.ATMOS_STORE_ID),
    };

    console.log('[ATMOS APPLY API PAYLOAD]', JSON.stringify(payload, null, 2));

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await atmosRes.json();
    console.log(`[ATMOS APPLY API RESPONSE] Status: ${atmosRes.status}`);
    console.log(JSON.stringify(data, null, 2));

    const errInfo = analyzeAtmosError(data);

    const resCode = data?.result?.code ?? data?.code;
    const isSuccess = resCode === 'OK' || resCode === 1 || resCode === '1' || resCode === 0;

    if (!isSuccess) {
      const errorMsg = errInfo?.messageRu || errInfo?.message || data?.result?.description || 'Payment confirmation failed';
      console.error(`[ATMOS APPLY FAILED] ${errorMsg}`);
      return res.status(400).json({
        error: errorMsg,
        hint: data?.hint || (errInfo?.is102 ? 102 : undefined),
        detail: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[ATMOS APPLY EXCEPTION]', err);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Visa/Mastercard payment (IPS)
//  POST /api/pay/mps
// ─────────────────────────────────────────────
app.post('/api/pay/mps', paymentLimiter, async (req, res) => {
  const reqTime = new Date().toISOString();
  try {
    const { pan, expiry, amount, card_name, cvc2, ext_id } = req.body;

    console.log(`\n==================================================`);
    console.log(`[ATMOS MPS PAY REQUEST] ${reqTime}`);
    console.log(`  PAN       : ${maskCard(pan)}`);
    console.log(`  Amount    : ${amount}`);
    console.log(`  Card Name : ${card_name}`);
    console.log(`  Ext ID    : ${ext_id}`);

    if (!pan || !expiry || !amount || !card_name || !cvc2 || !ext_id) {
      return res.status(400).json({ error: 'All card fields are required' });
    }

    if (isMockMode) {
      const mockMps = {
        status: {
          code: 0,
          message: 'Success'
        },
        payload: {
          id: 'mock-mps-tx-' + Math.random().toString(36).substr(2, 9)
        },
        mock: true
      };
      console.log('[MOCK ATMOS MPS RESPONSE]', JSON.stringify(mockMps, null, 2));
      return res.json(mockMps);
    }

    const token = await getAtmosToken();

    // Step 1: Create draft transaction
    const preCreatePayload = {
      amount: Math.round(Number(amount) * 100),
      ext_id,
      store_id: Number(process.env.ATMOS_STORE_ID),
      ofd_items: [],
      account: ext_id,
    };

    console.log('[ATMOS MPS PRE-CREATE PAYLOAD]', JSON.stringify(preCreatePayload, null, 2));

    const preCreateRes = await fetch(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/pre-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: process.env.ATMOS_KEY,
      },
      body: JSON.stringify(preCreatePayload),
    });
    const preCreateData = await preCreateRes.json();
    console.log('[ATMOS MPS PRE-CREATE RESPONSE]', JSON.stringify(preCreateData, null, 2));

    if (preCreateData?.status?.code !== 0) {
      throw new Error(preCreateData?.status?.message || 'Failed to create MPS transaction');
    }

    const transaction_id = preCreateData.payload.id;

    // Step 2: Attach card and charge
    const createPayload = {
      pan: String(pan).replace(/\s/g, ''),
      expiry: normalizeExpiry(expiry),
      amount: Math.round(Number(amount) * 100),
      transaction_id,
      card_name,
      cvc2,
      client_ip_addr: req.ip || '127.0.0.1',
      ext_id,
    };

    console.log('[ATMOS MPS CREATE PAYLOAD]', JSON.stringify({
      ...createPayload,
      pan: maskCard(pan),
      cvc2: '***'
    }, null, 2));

    const createRes = await fetch(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: process.env.ATMOS_KEY,
      },
      body: JSON.stringify(createPayload),
    });

    const data = await createRes.json();
    console.log('[ATMOS MPS CREATE RESPONSE]', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    console.error('[ATMOS MPS EXCEPTION]', err);
    res.status(502).json({ error: 'International card payment error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Webhook receiver (Atmos → our server)
//  POST /api/webhook/atmos
// ─────────────────────────────────────────────
app.post('/api/webhook/atmos', async (req, res) => {
  try {
    const payload = req.body;
    console.log('\n==================================================');
    console.log('[ATMOS WEBHOOK RECEIVED]', JSON.stringify(payload, null, 2));

    const { email, plan, months, expiryDate } = payload;

    // Auto-provision RAGFlow user after confirmed payment
    if (email && payload.confirmed) {
      try {
        const result = await provisionUser({ email, plan, months, expiryDate });
        console.log('[ATMOS WEBHOOK] RAGFlow provisioning result:', result);
      } catch (rfErr) {
        console.error('[ATMOS WEBHOOK] RAGFlow provisioning failed:', rfErr.message);
      }
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[ATMOS WEBHOOK EXCEPTION]', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Provision RAGFlow user after payment
//  POST /api/ragflow/provision
// ─────────────────────────────────────────────
app.post('/api/ragflow/provision', async (req, res) => {
  try {
    const { email, plan, months, expiryDate, amount, payment_id } = req.body;
    console.log(`[RAGFLOW PROVISION REQUEST] Email: ${email}, Plan: ${plan}, Months: ${months}`);

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const result = await provisionUser({ email, plan, months, expiryDate });

    let licenseKey = null;
    const isLicensePlan = plan && plan.toLowerCase().includes('license');
    if (isLicensePlan) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
      const expStr = expDate.toISOString().split('T')[0];
      const payload = {
        owner: email,
        expiry: expStr,
        type: Number(months || 1) >= 12 ? 'yearly' : '6-month',
        amount: amount || (Number(months || 1) >= 12 ? 500000 : 300000),
        payment_id: payment_id || 'manual-activation',
        activated_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
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
    base_url: process.env.ATMOS_BASE_URL,
    mock_mode: isMockMode,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Atmos payment server running on http://localhost:${PORT}`);
  console.log(`   Store ID  : ${process.env.ATMOS_STORE_ID}`);
  console.log(`   Mock Mode : ${isMockMode}`);
  console.log(`   CORS      : ${process.env.FRONTEND_URL}`);
  console.log(`   Health    : http://localhost:${PORT}/api/health\n`);
});

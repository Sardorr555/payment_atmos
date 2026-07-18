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

const isMockMode = process.env.MOCK_PAYMENT === 'true' || 
                   !process.env.ATMOS_KEY || 
                   process.env.ATMOS_KEY.includes('YOUR_') || 
                   process.env.ATMOS_KEY === 'TpLRLagJ1SXiZ0dT_om5BT_I3Nga' ||
                   !process.env.ATMOS_SECRET || 
                   process.env.ATMOS_SECRET === 'bMH7gjat2EgI3fTXoLJX7CRUcbAa';

console.log(`[ATMOS INTEGRATION] Mock mode: ${isMockMode}`);

// ─────────────────────────────────────────────
//  Atmos Auth helper — runs on the SERVER only
//  API keys never leave this file
// ─────────────────────────────────────────────
const getAtmosToken = async () => {
  if (isMockMode) {
    return 'mock-token';
  }

  const auth = Buffer.from(
    `${process.env.ATMOS_KEY}:${process.env.ATMOS_SECRET}`
  ).toString('base64');

  const res = await fetch(`${process.env.ATMOS_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error(`Atmos auth failed: ${res.status}`);
  const data = await res.json();
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

    if (isMockMode) {
      const mockTx = {
        transaction_id: 'mock-tx-' + Math.random().toString(36).substr(2, 9),
        amount: amount,
        mock: true
      };
      console.log('[MOCK ATMOS PAY CREATE]', JSON.stringify(mockTx));
      return res.json(mockTx);
    }

    const token = await getAtmosToken();

    const requestBody = {
      amount: Math.round(Number(amount) * 100), // тийины
      account,
      store_id: Number(process.env.ATMOS_STORE_ID),
      lang,
    };
    console.log('[ATMOS PAY CREATE REQUEST]', JSON.stringify(requestBody, null, 2));

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await atmosRes.json();
    console.log('[ATMOS PAY CREATE RESPONSE]', JSON.stringify(data, null, 2));

    if (!data.transaction_id) {
      return res.status(400).json({
        error: data.result?.description || 'Failed to create Atmos transaction',
        detail: data
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[/api/pay/create]', err.message);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
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

    if (isMockMode) {
      const mockPre = {
        status: 'waiting_otp',
        phone: '+998 90 *** ** 99',
        phone_number: '+998 90 *** ** 99',
        mock: true
      };
      console.log('[MOCK ATMOS PRE-APPLY]', JSON.stringify(mockPre));
      return res.json(mockPre);
    }

    const token = await getAtmosToken();

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/pre-apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id,
        card_number,
        expiry,
        store_id: Number(process.env.ATMOS_STORE_ID),
      }),
    });

    const data = await atmosRes.json();
    console.log('[ATMOS PRE-APPLY RESPONSE]', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    console.error('[/api/pay/pre-apply]', err.message);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Apply (confirm OTP → complete payment)
//  POST /api/pay/apply
// ─────────────────────────────────────────────
app.post('/api/pay/apply', paymentLimiter, async (req, res) => {
  try {
    const { transaction_id, otp } = req.body;

    if (!transaction_id || !otp) {
      return res.status(400).json({ error: 'transaction_id and otp are required' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'OTP must be exactly 6 digits' });
    }

    if (isMockMode) {
      const mockApply = {
        result: {
          code: 'OK',
          description: 'Success'
        },
        mock: true
      };
      console.log('[MOCK ATMOS APPLY]', JSON.stringify(mockApply));
      return res.json(mockApply);
    }

    const token = await getAtmosToken();

    const atmosRes = await fetch(`${process.env.ATMOS_BASE_URL}/merchant/pay/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        transaction_id,
        otp,
        store_id: Number(process.env.ATMOS_STORE_ID),
      }),
    });

    const data = await atmosRes.json();
    console.log('[ATMOS APPLY RESPONSE]', JSON.stringify(data, null, 2));

    // Extra check: only return success if Atmos confirms it
    if (data?.result?.code !== 'OK') {
      return res.status(400).json({ error: data?.result?.description || 'Payment failed' });
    }

    res.json(data);
  } catch (err) {
    console.error('[/api/pay/apply]', err.message);
    res.status(502).json({ error: 'Payment gateway error', detail: err.message });
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
      console.log('[MOCK ATMOS MPS]', JSON.stringify(mockMps));
      return res.json(mockMps);
    }

    const token = await getAtmosToken();

    // Step 1: Create draft transaction
    const preCreateRes = await fetch(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/pre-create`, {
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
    });
    const preCreateData = await preCreateRes.json();

    if (preCreateData?.status?.code !== 0) {
      throw new Error(preCreateData?.status?.message || 'Failed to create MPS transaction');
    }

    const transaction_id = preCreateData.payload.id;

    // Step 2: Attach card and charge
    const createRes = await fetch(`${process.env.ATMOS_BASE_URL}/mps/pay/transaction/create`, {
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
        client_ip_addr: req.ip || '127.0.0.1', // real client IP from server
        ext_id,
      }),
    });

    const data = await createRes.json();
    res.json(data);
  } catch (err) {
    console.error('[/api/pay/mps]', err.message);
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
    console.log('[WEBHOOK] Atmos notification received:', JSON.stringify(payload, null, 2));

    const { email, plan, months, expiryDate } = payload;

    // Auto-provision RAGFlow user after confirmed payment
    if (email && payload.confirmed) {
      try {
        const result = await provisionUser({ email, plan, months, expiryDate });
        console.log('[WEBHOOK] RAGFlow provisioning:', result);
      } catch (rfErr) {
        console.error('[WEBHOOK] RAGFlow provisioning failed:', rfErr.message);
        // Don't fail the webhook — log and continue
      }
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: Provision RAGFlow user after payment
//  Called from frontend after successful payment
//  POST /api/ragflow/provision
// ─────────────────────────────────────────────
app.post('/api/ragflow/provision', async (req, res) => {
  try {
    const { email, plan, months, expiryDate, amount, payment_id } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const result = await provisionUser({ email, plan, months, expiryDate });

    let licenseKey = null;
    const isLicensePlan = plan && plan.toLowerCase().includes('license');
    if (isLicensePlan) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + Number(months || 1) * 30);
      const expStr = expDate.toISOString().split('T')[0]; // YYYY-MM-DD
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
      tempPassword: result.tempPassword, // only set for new users
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
    // Simple admin token check
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
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Atmos payment server running on http://localhost:${PORT}`);
  console.log(`   Store ID : ${process.env.ATMOS_STORE_ID}`);
  console.log(`   CORS     : ${process.env.FRONTEND_URL}`);
  console.log(`   Health   : http://localhost:${PORT}/api/health\n`);
});

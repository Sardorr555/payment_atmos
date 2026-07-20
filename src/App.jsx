import React, { useState, useEffect } from 'react';
import { CreditCard, CheckCircle, ShieldAlert, LogIn, Loader2, Users, Settings, Trash2, LayoutDashboard, Crown, Sparkles } from 'lucide-react';

const formatUZS = (amount) => {
  return new Intl.NumberFormat('uz-UZ', { style: 'currency', currency: 'UZS', maximumFractionDigits: 0 }).format(amount);
};

// Fallback UUID generator for non-secure contexts (HTTP) where crypto.randomUUID is not available
const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// API keys are stored on the backend server — never in the frontend!
// All payment calls go through our secure Express proxy at /api/*


// ==========================================
// 1. Atmos Modal Component
// ==========================================
const AtmosModal = ({ isOpen, onClose, onSuccess, amount, title, email }) => {
  const [step, setStep] = useState('card'); // card, processing_card, otp, processing_otp, success
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [hint102Error, setHint102Error] = useState(false);
  const [rawDetails, setRawDetails] = useState(null);
  const [showRawDetails, setShowRawDetails] = useState(false);
  const [transactionId, setTransactionId] = useState(null);
  const [cvc, setCvc] = useState('');
  const [cardName, setCardName] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');

  const cleanCardNumber = cardNumber.replace(/\s/g, '');
  
  // Local card checks (Uzcard starts with 8600/5614, Humo starts with 9860/5440)
  const isLocalCard = cleanCardNumber.startsWith('8600') || 
                      cleanCardNumber.startsWith('9860') || 
                      cleanCardNumber.startsWith('5614') || 
                      cleanCardNumber.startsWith('5440');

  const isVisaOrMastercard = !isLocalCard && (cleanCardNumber.startsWith('4') || cleanCardNumber.startsWith('5'));

  useEffect(() => {
    if (isOpen) {
      setStep('card');
      setCardNumber('');
      setExpiry('');
      setOtp('');
      setError('');
      setHint102Error(false);
      setRawDetails(null);
      setShowRawDetails(false);
      setMaskedPhone('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCardSubmit = async (e) => {
    e.preventDefault();
    if (cardNumber.replace(/\s/g, '').length < 16 || expiry.length < 5) {
      setError('Please enter a valid card number and expiry date');
      return;
    }
    setError('');
    setHint102Error(false);
    setStep('processing_card');

    try {
      // Format Expiry MM/YY → YYMM for API
      const [month, year] = expiry.split('/');
      const formattedExpiry = `${year}${month}`;

      console.log('[ATMOS FRONTEND] Submitting payment request...', {
        amount,
        account: email,
        isVisaOrMastercard,
        expiryFormatted: formattedExpiry
      });

      if (isVisaOrMastercard) {
        // ── Visa / Mastercard (IPS) ──────────────────────────────────
        if (cvc.length < 3 || cardName.trim().length === 0) {
          setError('Please enter valid CVC and Cardholder Name for international cards');
          setStep('card');
          return;
        }

        const res = await fetch('/api/pay/mps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pan: cleanCardNumber,
            expiry: formattedExpiry,
            amount,
            card_name: cardName,
            cvc2: cvc,
            ext_id: generateUUID(),
          }),
        });
        const txData = await res.json();
        console.log('[ATMOS FRONTEND MPS RESPONSE]', txData);

        if (!res.ok) throw new Error(txData.error || 'International card error');

        if (txData.payload?.redirect_uri) {
          window.location.href = txData.payload.redirect_uri;
          return;
        }
        setStep('success');
      } else {
        // ── Uzcard / Humo ────────────────────────────────────────────
        // Step 1: Create transaction
        console.log('[ATMOS FRONTEND] Step 1: Creating payment transaction...');
        const createRes = await fetch('/api/pay/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, account: email || 'unknown' }),
        });
        const txData = await createRes.json();
        console.log('[ATMOS FRONTEND CREATE RESPONSE]', txData);

        if (!createRes.ok) {
          setRawDetails(txData.detail || txData);
          const is102 = txData.hint === 102 || 
                        txData.detail?.hint === 102 || 
                        txData.detail?.result?.code === 102 ||
                        String(txData.error).includes('102') ||
                        String(txData.error).toLowerCase().includes('sms');
          if (is102) setHint102Error(true);
          const msg = is102 
            ? 'Ошибка СМС-информирования (Код 102): Не удалось запросить отправку СМС на эту карту.' 
            : (txData.error || txData.result?.description || 'Не удалось создать платеж');
          throw new Error(msg);
        }

        setTransactionId(txData.transaction_id);

        // Step 2: Pre-apply (request OTP SMS)
        console.log('[ATMOS FRONTEND] Step 2: Pre-applying (requesting SMS OTP)...', txData.transaction_id);
        const preRes = await fetch('/api/pay/pre-apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction_id: txData.transaction_id,
            card_number: cleanCardNumber,
            expiry: formattedExpiry,
          }),
        });
        const preData = await preRes.json();
        console.log('[ATMOS FRONTEND PRE-APPLY RESPONSE]', preData);

        if (!preRes.ok) {
          setRawDetails(preData.detail || preData);
          const is102 = preData.hint === 102 || 
                        preData.detail?.hint === 102 || 
                        preData.detail?.result?.code === 102 ||
                        String(preData.error).includes('102') ||
                        String(preData.error).toLowerCase().includes('sms');
          if (is102) setHint102Error(true);
          const msg = is102 
            ? 'Ошибка СМС-информирования (Код 102): СМС с кодом не отправлено на карту.' 
            : (preData.error || preData.result?.description || 'Не удалось отправить СМС код');
          throw new Error(msg);
        }

        const phone = preData.phone || preData.phone_number || preData.phoneMask || (preData.payload && preData.payload.phone) || '';
        setMaskedPhone(phone);
        setStep('otp');
      }
    } catch (err) {
      console.error('[ATMOS FRONTEND ERROR]', err);
      if (String(err.message).includes('102')) {
        setHint102Error(true);
      }
      setError(err.message || 'Ошибка платежного шлюза. Проверьте настройки API.');
      setStep('card');
    }
  };

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    if (otp.length < 6) {
      setError('Enter the 6-digit OTP code');
      return;
    }
    setError('');
    setHint102Error(false);
    setStep('processing_otp');

    try {
      console.log('[ATMOS FRONTEND] Step 3: Confirming OTP for tx:', transactionId);
      const res = await fetch('/api/pay/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId, otp }),
      });
      const confirmData = await res.json();
      console.log('[ATMOS FRONTEND APPLY RESPONSE]', confirmData);

      if (!res.ok) {
        if (confirmData.hint === 102 || confirmData.detail?.hint === 102 || String(confirmData.error).includes('102')) {
          setHint102Error(true);
        }
        throw new Error(confirmData.error || 'Payment confirmation failed');
      }

      setStep('success');
    } catch (err) {
      console.error('[ATMOS FRONTEND OTP ERROR]', err);
      setError(err.message || 'Invalid OTP or API error.');
      setStep('otp');
    }
  };

  const formatCardNumber = (value) => {
    const v = value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    const matches = v.match(/\d{4,16}/g);
    const match = matches && matches[0] || '';
    const parts = [];
    for (let i = 0, len = match.length; i < len; i += 4) {
      parts.push(match.substring(i, i + 4));
    }
    if (parts.length) {
      return parts.join(' ');
    } else {
      return value;
    }
  };

  const formatExpiry = (value) => {
    const v = value.replace(/\s+/g, '').replace(/[^0-9]/gi, '');
    if (v.length >= 2) {
      return v.substring(0, 2) + '/' + v.substring(2, 4);
    }
    return v;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="glassmorphism rounded-2xl w-full max-w-md p-8 relative flex flex-col items-center shadow-2xl border border-blue-600/20">

        {/* Close Button */}
        {(step === 'card' || step === 'otp') && (
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white text-xl p-2 leading-none">
            &times;
          </button>
        )}

        {(step === 'card' || step === 'processing_card') && (
          <div className="w-full">
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-full bg-blue-600/10 flex items-center justify-center mx-auto mb-4">
                <CreditCard className="w-6 h-6 text-blue-500" />
              </div>
              <h3 className="text-2xl text-white font-syne mb-1">Pay with Card</h3>
              <p className="text-gray-400 text-sm">Uzcard / Humo / Visa / Mastercard </p>
            </div>

            <div className="w-full bg-navy-800 rounded-xl p-4 border border-white/5 mb-6 text-sm">
              <div className="flex justify-between items-center mb-2">
                <span className="text-gray-400">Order:</span>
                <span className="font-medium text-white">{title}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Total to pay:</span>
                <span className="font-bold text-blue-400 text-lg">{formatUZS(amount)}</span>
              </div>
            </div>

            <form onSubmit={handleCardSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Card Number</label>
                <input
                  type="text"
                  placeholder="0000 0000 0000 0000"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
                  maxLength="19"
                  disabled={step === 'processing_card'}
                  className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono tracking-wider"
                  required
                />
              </div>
              <div className={isVisaOrMastercard ? "grid grid-cols-2 gap-4" : ""}>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Expiry Date</label>
                  <input
                    type="text"
                    placeholder="MM/YY"
                    value={expiry}
                    onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                    maxLength="5"
                    disabled={step === 'processing_card'}
                    className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono tracking-wider"
                    required
                  />
                </div>
                {isVisaOrMastercard && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">CVC</label>
                    <input
                      type="password"
                      placeholder="123"
                      value={cvc}
                      onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      disabled={step === 'processing_card'}
                      className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono tracking-wider"
                      required
                    />
                  </div>
                )}
              </div>

              {isVisaOrMastercard && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Cardholder Name</label>
                  <input
                    type="text"
                    placeholder="JOHN DOE"
                    value={cardName}
                    onChange={(e) => setCardName(e.target.value.toUpperCase())}
                    disabled={step === 'processing_card'}
                    className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 font-mono tracking-wider"
                    required
                  />
                </div>
              )}

              {hint102Error ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 my-3 text-xs text-amber-300 text-left space-y-2">
                  <div className="flex items-center gap-2 font-bold text-amber-400">
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>СМС-уведомление не отправлено (Код / Hint 102)</span>
                  </div>
                  <p>
                    На карте Uzcard / Humo не удалось запросить СМС с кодом.
                  </p>
                  <ul className="list-disc pl-4 space-y-1 text-amber-200/90 text-[11px]">
                    <li>Убедитесь, что на вашей карте <strong>включено СМС-информирование</strong> (в мобильном банке или банкомате).</li>
                    <li>Проверьте правильно ли введён номер карты и срок действия.</li>
                    <li>Попробуйте другую карту Uzcard, Humo, Visa или Mastercard.</li>
                  </ul>
                </div>
              ) : error ? (
                <p className="text-red-400 text-sm text-center my-2">{error}</p>
              ) : null}

              {rawDetails && (
                <div className="my-2 text-left">
                  <button
                    type="button"
                    onClick={() => setShowRawDetails(!showRawDetails)}
                    className="text-[11px] text-gray-400 underline hover:text-white transition-colors"
                  >
                    {showRawDetails ? '▼ Скрыть сырой ответ Atmos API' : '▶ Показать сырой ответ Atmos API'}
                  </button>
                  {showRawDetails && (
                    <pre className="mt-1 p-3 bg-navy-950/90 rounded-xl border border-white/10 text-[10px] text-red-300 font-mono overflow-x-auto max-h-36 select-all">
                      {JSON.stringify(rawDetails, null, 2)}
                    </pre>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={step === 'processing_card'}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-medium transition-colors flex justify-center items-center gap-2 mt-2"
              >
                {step === 'processing_card' ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Continue'}
              </button>
            </form>
          </div>
        )}

        {(step === 'otp' || step === 'processing_otp') && (
          <div className="w-full text-center">
            <div className="w-12 h-12 rounded-full bg-blue-600/10 flex items-center justify-center mx-auto mb-4">
              <ShieldAlert className="w-6 h-6 text-blue-500" />
            </div>
            <h3 className="text-2xl text-white font-syne mb-2">Confirmation Code</h3>
            <p className="text-gray-400 text-sm mb-6">
              An SMS with a 6-digit code has been sent to your phone number{maskedPhone ? ` (${maskedPhone})` : ''}.
            </p>

            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div>
                <input
                  type="text"
                  placeholder="000 000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').substring(0, 6))}
                  disabled={step === 'processing_otp'}
                  className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white text-center text-xl tracking-[0.5em] focus:outline-none focus:border-blue-500 font-mono"
                  required
                />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={step === 'processing_otp'}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-medium transition-colors flex justify-center items-center gap-2"
              >
                {step === 'processing_otp' ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Confirm Payment'}
              </button>

              {step === 'otp' && (
                <button type="button" onClick={() => setStep('card')} className="text-gray-400 text-sm hover:text-white mt-4 transition-colors">
                  Cancel and use another card
                </button>
              )}
            </form>
          </div>
        )}

        {step === 'success' && (
          <div className="w-full text-center animate-in zoom-in-95 duration-300">
            <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mb-6 mx-auto">
              <CheckCircle className="w-10 h-10 text-emerald-400" />
            </div>
            <h3 className="text-2xl mb-2 text-white font-syne">Payment Successful!</h3>
            <p className="text-emerald-400/80 mb-8">Your transaction has been processed securely via Atmos.</p>
            <button
              onClick={() => {
                onSuccess();
                onClose();
              }}
              className="px-8 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-medium transition-all shadow-[0_0_20px_rgba(37,99,235,0.4)] w-full"
            >
              Continue to Swipes AI
            </button>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-gray-500 border-t border-white/5 pt-4 w-full">
          <ShieldAlert className="w-3 h-3" /> Protected by Atmos Secure Gateway
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 2. Payment Page Component
// ==========================================
const PaymentPage = ({ settings, setUsers }) => {
  // Read email from URL params (when user comes from swipies.app already logged in)
  const urlEmail = new URLSearchParams(window.location.search).get('email') || '';

  const [email, setEmail] = useState(urlEmail);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [ragflowResult, setRagflowResult] = useState(null); // provisioning result
  const [selectedTier, setSelectedTier] = useState('pro');
  const [selectedMonths, setSelectedMonths] = useState(1);

  const TIERS = {
    plus:       { label: 'Plus',       pricePerMonth: 199000 },
    pro:        { label: 'Pro',        pricePerMonth: 400000 },
  };

  const PERIODS = [
    { months: 1,  label: '1 месяц',   badge: null },
    { months: 6,  label: '6 месяцев', badge: '−10%' },
    { months: 12, label: '1 год',     badge: '−20%' },
  ];

  const DISCOUNTS = { 1: 1, 6: 0.9, 12: 0.8 };

  const tier = TIERS[selectedTier];
  const discount = DISCOUNTS[selectedMonths];
  const totalAmount = Math.round(tier.pricePerMonth * selectedMonths * discount);
  const savedAmount = Math.round(tier.pricePerMonth * selectedMonths * (1 - discount));

  const currentPlan = {
    title: `${tier.label} · ${selectedMonths} мес.`,
    amount: totalAmount,
    duration: selectedMonths * 30,
    plan: tier.label,
  };

  const [emailError, setEmailError] = useState('');

  const handlePay = (e) => {
    e.preventDefault();
    setEmailError('');
    const trimmed = (email || '').trim();
    if (!trimmed || !trimmed.includes('@')) {
      setEmailError('Пожалуйста, введите корректный Email адрес (например, name@domain.com)');
      return;
    }
    setIsModalOpen(true);
  };

  const handlePaymentSuccess = async () => {
    const startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(startDate.getDate() + currentPlan.duration);

    const newUser = {
      id: Date.now().toString(),
      email,
      plan: currentPlan.plan,
      amountPaid: currentPlan.amount,
      startDate: startDate.toISOString(),
      expiryDate: expiryDate.toISOString(),
      status: 'Active'
    };

    setUsers(prev => {
      const newUsers = [newUser, ...prev];
      localStorage.setItem('swipes_users', JSON.stringify(newUsers));
      return newUsers;
    });

    // ─ Provision user in RAGFlow ─────────────────────────────────
    try {
      const expiryDate = newUser.expiryDate;
      const res = await fetch('/api/ragflow/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          plan: currentPlan.plan,
          months: selectedMonths,
          expiryDate,
        }),
      });
      const rfData = await res.json();
      setRagflowResult(rfData);
    } catch (rfErr) {
      console.warn('RAGFlow provisioning error (non-critical):', rfErr.message);
      setRagflowResult({ success: false, error: rfErr.message });
    }

    setIsSuccess(true);
  };

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-grid">
        <div className="glassmorphism p-10 rounded-3xl max-w-md w-full text-center border-t border-blue-500/30">
          <div className="w-20 h-20 bg-blue-600/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-10 h-10 text-blue-400" />
          </div>
          <h2 className="text-3xl font-syne mb-2 text-glow">Оплата прошла!</h2>
          <p className="text-gray-400 mb-6 text-sm">
            Тариф <span className="text-white font-semibold">{currentPlan.plan}</span> · {selectedMonths} мес.
          </p>

          {/* RAGFlow provisioning result */}
          {ragflowResult?.success ? (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-6 text-left">
              <p className="text-emerald-400 font-semibold text-sm mb-2">
                {ragflowResult.isNewUser ? '✅ Аккаунт создан' : '✅ Подписка активирована'}
              </p>
              <p className="text-gray-300 text-sm mb-1">Email: <span className="text-white">{email}</span></p>
              {ragflowResult.isNewUser && ragflowResult.tempPassword && (
                <p className="text-gray-300 text-sm mb-1">
                  Пароль: <span className="font-mono text-yellow-400 select-all">{ragflowResult.tempPassword}</span>
                  <span className="text-gray-500 text-xs block mt-1">Сохрани пароль — больше не покажем</span>
                </p>
              )}
              <a
                href={`${ragflowResult.ragflowUrl}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 mt-3 w-full justify-center bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-xl text-sm font-medium transition-all"
              >
                Войти в Swipes AI →
              </a>
            </div>
          ) : ragflowResult?.error ? (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm text-red-400">
              Оплата прошла, но возникла ошибка при активации аккаунта. Напиши в поддержку с email: {email}
            </div>
          ) : (
            <div className="bg-white/5 rounded-xl p-4 mb-6 text-sm text-gray-400">
              Активируем аккаунт...
            </div>
          )}

          <button
            onClick={() => window.location.href = '/'}
            className="px-8 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-colors font-medium w-full text-sm"
          >
            Вернуться на главную
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-grid relative overflow-hidden">
      {/* Background glowing orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-600/10 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="mb-10 text-center z-10">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.5)]">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-4xl font-syne tracking-tight text-white">Swipes AI</h1>
        </div>
        <p className="text-gray-400 max-w-md mx-auto">Upgrade your intelligence suite with premium access.</p>
      </div>

      <div className="glassmorphism rounded-3xl w-full max-w-md overflow-hidden shadow-2xl z-10 border border-white/5">
        <div className="p-8 bg-gradient-to-br from-white/5 to-transparent border-b border-white/5">
          {/* Tier selector */}
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Тариф</p>
          <div className="flex gap-3 mb-6">
            {Object.entries(TIERS).map(([key, t]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedTier(key)}
                className={`flex-1 p-4 rounded-2xl border transition-all text-left ${
                  selectedTier === key
                    ? 'bg-blue-600/20 border-blue-500 shadow-[0_0_15px_rgba(37,99,235,0.3)]'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                <div className="text-sm font-syne text-white mb-1">{t.label}</div>
                <div className="text-lg font-bold text-blue-400">{formatUZS(t.pricePerMonth)}<span className="text-xs text-gray-400 font-normal">/мес</span></div>
              </button>
            ))}
          </div>

          {/* Period selector */}
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Период</p>
          <div className="flex gap-2 mb-6">
            {PERIODS.map(({ months, label, badge }) => (
              <button
                key={months}
                type="button"
                onClick={() => setSelectedMonths(months)}
                className={`flex-1 py-3 px-2 rounded-xl border transition-all text-center relative ${
                  selectedMonths === months
                    ? 'bg-blue-600/20 border-blue-500 shadow-[0_0_12px_rgba(37,99,235,0.3)]'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                {badge && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
                    {badge}
                  </span>
                )}
                <div className="text-xs text-white font-medium">{label}</div>
              </button>
            ))}
          </div>

          {/* Price summary */}
          <div className="bg-white/5 rounded-xl p-4 border border-white/5">
            <div className="flex justify-between items-center mb-1">
              <span className="text-gray-400 text-sm">{tier.label} × {selectedMonths} мес.</span>
              <span className="text-gray-400 text-sm line-through">{formatUZS(tier.pricePerMonth * selectedMonths)}</span>
            </div>
            {savedAmount > 0 && (
              <div className="flex justify-between items-center mb-2">
                <span className="text-emerald-400 text-xs">Скидка</span>
                <span className="text-emerald-400 text-xs font-medium">−{formatUZS(savedAmount)}</span>
              </div>
            )}
            <div className="flex justify-between items-center border-t border-white/10 pt-2">
              <span className="text-white font-semibold">Итого</span>
              <span className="text-2xl font-bold text-white">{formatUZS(totalAmount)}</span>
            </div>
          </div>
        </div>

        <form onSubmit={handlePay} className="p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Email</label>
            <div className="relative">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                readOnly={!!urlEmail} // lock if pre-filled from swipies.app
                placeholder="you@example.com"
                className={`w-full bg-navy-900 border rounded-xl px-4 py-3 text-white placeholder:text-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all ${
                  urlEmail ? 'border-blue-500/40 text-blue-300 cursor-not-allowed' : 'border-white/10'
                }`}
              />
              {urlEmail && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                  из Swipes AI
                </span>
              )}
            </div>
            {emailError && (
              <p className="text-xs text-red-400 mt-1">{emailError}</p>
            )}
            {urlEmail && (
              <p className="text-xs text-gray-500">Email взят из вашей учётной записи Swipes AI</p>
            )}
          </div>

          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-xl font-medium transition-all shadow-[0_0_20px_rgba(37,99,235,0.3)] hover:shadow-[0_0_25px_rgba(37,99,235,0.5)]"
          >
            <CreditCard className="w-5 h-5" />
            Pay via Atmos
          </button>

          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <ShieldAlert className="w-4 h-4" />
            Secured by Atmos UZ Gateway
          </div>
        </form>
      </div>

      <AtmosModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handlePaymentSuccess}
        amount={currentPlan.amount}
        title={currentPlan.title}
        email={email}
      />
    </div>
  );
};

// ==========================================
// 3. Admin Panel Component
// ==========================================
const AdminPanel = ({ settings, setSettings, users, setUsers }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('settings');

  // Form states for manual user add
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPlan, setNewUserPlan] = useState('Pro');

  const handleLogin = (e) => {
    e.preventDefault();
    if (password === 'admin123') {
      setIsAuthenticated(true);
      setError('');
    } else {
      setError('Invalid password');
    }
  };

  const handleSaveSettings = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const newSettings = {
      title: formData.get('title'),
      amount: formData.get('amount'),
      plan: formData.get('plan'),
      duration: formData.get('duration')
    };
    setSettings(newSettings);
    localStorage.setItem('swipes_settings', JSON.stringify(newSettings));
    alert('Settings saved successfully!');
  };

  const handleAddUser = (e) => {
    e.preventDefault();
    if (!newUserEmail) return;

    const startDate = new Date();
    const expiryDate = new Date();
    // Use current settings duration for manual additions
    expiryDate.setDate(startDate.getDate() + Number(settings.duration));

    const newUser = {
      id: Date.now().toString(),
      email: newUserEmail,
      plan: newUserPlan,
      amountPaid: 0, // Manual grant
      startDate: startDate.toISOString(),
      expiryDate: expiryDate.toISOString(),
      status: 'Active'
    };

    setUsers(prev => {
      const newUsers = [newUser, ...prev];
      localStorage.setItem('swipes_users', JSON.stringify(newUsers));
      return newUsers;
    });

    setNewUserEmail('');
    alert('User access granted successfully!');
  };

  const handleDeleteUser = (id) => {
    if (confirm('Are you sure you want to revoke access for this user?')) {
      setUsers(prev => {
        const newUsers = prev.filter(u => u.id !== id);
        localStorage.setItem('swipes_users', JSON.stringify(newUsers));
        return newUsers;
      });
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-navy">
        <div className="glassmorphism p-8 rounded-2xl max-w-sm w-full">
          <div className="flex justify-center mb-6">
            <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
              <LogIn className="w-6 h-6 text-white" />
            </div>
          </div>
          <h2 className="text-2xl font-syne mb-6 text-center text-white">Admin Access</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password..."
                className="w-full bg-navy-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
              {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
            </div>
            <button className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-medium transition-colors">
              Login to Dashboard
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy flex flex-col md:flex-row">
      {/* Sidebar */}
      <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-white/5 bg-navy-900/50 p-6 flex flex-col">
        <div className="flex items-center gap-3 mb-10">
          <Sparkles className="w-6 h-6 text-blue-500" />
          <span className="font-syne font-bold text-xl text-white">Swipes Admin</span>
        </div>

        <nav className="space-y-2 flex-1">
          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'settings' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.3)]' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
          >
            <Settings className="w-4 h-4" /> Payment Settings
          </button>
          <button
            onClick={() => setActiveTab('users')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-medium ${activeTab === 'users' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.3)]' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
          >
            <Users className="w-4 h-4" /> Access Management
          </button>
        </nav>

        <button
          onClick={() => window.location.href = '/'}
          className="mt-auto flex items-center gap-3 px-4 py-3 text-gray-500 hover:text-white transition-colors text-sm"
        >
          <LogIn className="w-4 h-4 transform rotate-180" /> View Public Page
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 md:p-10 overflow-y-auto">
        <h1 className="text-3xl font-syne text-white mb-8">
          {activeTab === 'settings' ? 'Payment Configuration' : 'User Access Management'}
        </h1>

        {activeTab === 'settings' && (
          <div className="max-w-2xl">
            <div className="glassmorphism rounded-2xl p-6 md:p-8 border border-white/5">
              <h2 className="text-xl font-medium text-white mb-6 flex items-center gap-2">
                <LayoutDashboard className="w-5 h-5 text-blue-400" /> Active Plan Details
              </h2>
              <form onSubmit={handleSaveSettings} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm text-gray-400">Payment Title</label>
                    <input
                      name="title"
                      defaultValue={settings.title}
                      className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-gray-400">Amount (UZS)</label>
                    <input
                      type="number"
                      name="amount"
                      defaultValue={settings.amount}
                      className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-gray-400">Plan Type</label>
                    <select
                      name="plan"
                      defaultValue={settings.plan}
                      className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                    >
                      <option value="Basic">Basic</option>
                      <option value="Pro">Pro</option>
                      <option value="Enterprise">Enterprise</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-gray-400">Duration (Days)</label>
                    <input
                      type="number"
                      name="duration"
                      defaultValue={settings.duration}
                      className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                      required
                    />
                  </div>
                </div>
                <button type="submit" className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl font-medium transition-colors">
                  Save & Activate
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="space-y-8">
            {/* Add User Manually */}
            <div className="glassmorphism rounded-2xl p-6 border border-white/5 max-w-4xl">
              <h2 className="text-lg font-medium text-white mb-4">Manually Grant Access</h2>
              <form onSubmit={handleAddUser} className="flex flex-col md:flex-row gap-4 items-end">
                <div className="flex-1 space-y-2 w-full">
                  <label className="text-sm text-gray-400">User Email</label>
                  <input
                    type="email"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>
                <div className="w-full md:w-48 space-y-2">
                  <label className="text-sm text-gray-400">Plan</label>
                  <select
                    value={newUserPlan}
                    onChange={(e) => setNewUserPlan(e.target.value)}
                    className="w-full bg-navy border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="Basic">Basic</option>
                    <option value="Pro">Pro</option>
                    <option value="Enterprise">Enterprise</option>
                  </select>
                </div>
                <button type="submit" className="w-full md:w-auto bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-xl font-medium transition-colors border border-white/10">
                  Grant Access
                </button>
              </form>
            </div>

            {/* Users Table */}
            <div className="glassmorphism rounded-2xl border border-white/5 overflow-hidden max-w-5xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-white/5 border-b border-white/5">
                      <th className="p-4 text-sm font-medium text-gray-400">Email</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Plan</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Amount Paid</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Start Date</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Expiry Date</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Status</th>
                      <th className="p-4 text-sm font-medium text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="p-8 text-center text-gray-500">
                          No users have active access yet.
                        </td>
                      </tr>
                    ) : (
                      users.map(user => {
                        const isExpired = new Date(user.expiryDate) < new Date();
                        return (
                          <tr key={user.id} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                            <td className="p-4 text-sm text-white font-medium">{user.email}</td>
                            <td className="p-4 text-sm text-gray-300">
                              <span className="inline-flex items-center px-2 py-1 rounded-md bg-blue-500/10 text-blue-400 text-xs">
                                {user.plan}
                              </span>
                            </td>
                            <td className="p-4 text-sm text-gray-300">
                              {user.amountPaid > 0 ? formatUZS(user.amountPaid) : 'Manual Grant'}
                            </td>
                            <td className="p-4 text-sm text-gray-400">{new Date(user.startDate).toLocaleDateString()}</td>
                            <td className="p-4 text-sm text-gray-400">{new Date(user.expiryDate).toLocaleDateString()}</td>
                            <td className="p-4">
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${isExpired ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                {isExpired ? 'Expired' : 'Active'}
                              </span>
                            </td>
                            <td className="p-4">
                              <button
                                onClick={() => handleDeleteUser(user.id)}
                                className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                title="Revoke Access"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ==========================================
// Main App Component
// ==========================================
export default function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  // Initialize Default Settings
  const defaultSettings = {
    title: 'Swipes AI — Pro Plan',
    amount: '199000',
    plan: 'Pro',
    duration: '30'
  };

  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('swipes_settings');
    return saved ? JSON.parse(saved) : defaultSettings;
  });

  const [users, setUsers] = useState(() => {
    const saved = localStorage.getItem('swipes_users');
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  // Simple Router
  if (currentPath === '/admin') {
    return <AdminPanel settings={settings} setSettings={setSettings} users={users} setUsers={setUsers} />;
  }

  return <PaymentPage settings={settings} setUsers={setUsers} />;
}

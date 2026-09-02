/* ============================================================
   Student page — 1% Healthy Habit
   - Reads ?u=<username> from the URL to know who is signed in.
   - Shows the student's points (server-backed) and the daily
     challenge (server-backed; shared with every student).
   - Mark-done posts to the server; the next reload shows it
     still done.
   ============================================================ */

(function () {
  'use strict';

  const API_BASE     = ''; // same-origin: static files and API are served from the same host
  const WELCOME_KEY  = 'student.welcomed.v1';
  const AVATAR_PALETTE = ['#8B5CF6', '#10B981', '#F43F5E', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#6366F1'];

  // ---------------- Identity ----------------
  // The username is the one fact the page must know about who is
  // viewing it. We read it from the URL (the Login server appends
  // ?u=<username> when it sends the student here). If it's missing
  // we show the "Sign in first" message and stop.
  const USERNAME = (() => {
    try {
      const u = new URLSearchParams(window.location.search).get('u');
      return u ? String(u).trim() : '';
    } catch (err) {
      return '';
    }
  })();

  // ---------------- State ----------------
  const state = {
    username: USERNAME,
    points: { score: 0, awardCount: 0, lastAwardedAt: null, loading: false, loaded: false, error: false },
    // The active challenge: text, kind, returnType. The legacy
    // markDone / done flags are gone — the challenge is "done" when
    // the student has at least one reply for it in state.myRepliesAll.
    challenge: { date: '', text: '', kind: '', returnType: null, id: '',
                 loading: false, error: null },
    // Notifications + messages + custom-challenge content (excludes
    // the daily-challenge, which is owned by `state.challenge` above).
    content: { loading: false, error: null, active: [] },
    archive: { open: false, items: [], loading: false, error: null,
               // Per-student archive (rows from .student-archive.json).
               // Rendered as a separate tab inside the archive drawer.
               studentItems: [], tab: 'global' },
    gradebook: { open: false, loading: false, students: [], error: null,
                 detail: { open: false, username: null, loading: false, error: null, data: null } },
    editUsername: { open: false, saving: false, error: null },
    // Reply dialog state. `parent` is { id, kind, returnType } —
    // the challenge or message we're replying to. `mediaFile` and
    // `audioBlob` are independently optional. `recording` tracks
    // the active MediaRecorder so we can stop on dialog close.
    // `required` is a {text, image, video, audio} map set by
    // renderDialogs() based on the parent's returnType — the submit
    // handler reads it to decide what's mandatory.
    // `cameraMode` is null / 'image' / 'video' — when set, the
    // live-camera block is open and the matching capture flow is
    // armed.
    reply: { open: false, parent: null, saving: false, error: null,
             text: '', mediaFile: null, mediaUrl: null,
             audioBlob: null, audioUrl: null, recording: false,
             required: { text: false, image: false, video: false, audio: false },
             cameraMode: null, cameraStream: null, cameraRecorder: null,
             cameraChunks: [] },
    // Per-parent reply list cache: { [parentId]: [reply, ...] }.
    // Used to render "Your replies" on message cards.
    myReplies: {},
    // Flat list of *all* of this student's replies (across every
    // parent, past and present). Used by the archive drawer.
    myRepliesAll: [],
    welcomeDialog: false,
    snackbar: null,
  };

  // ---------------- DOM ----------------
  const $ = sel => document.querySelector(sel);

  // ---------------- Media recorder (module-level so we can stop
  // a recording from anywhere — most importantly, when the dialog
  // is closed mid-recording).
  let _activeRecorder = null;
  let _activeRecorderChunks = [];
  function _stopMediaRecorder() {
    if (_activeRecorder && _activeRecorder.state !== 'inactive') {
      try { _activeRecorder.stop(); } catch (err) { /* ignore */ }
    }
    _activeRecorder = null;
  }

  // Tear down any active live-camera stream and matching video
  // MediaRecorder. Safe to call when nothing is open. Stops the
  // media tracks (which detaches the green camera-on light on
  // mobile), revokes no URLs (we keep the captured blob URL so
  // the preview stays visible), and hides the camera block.
  function _stopCamera() {
    if (state.reply && state.reply.cameraRecorder) {
      try { state.reply.cameraRecorder.stop(); } catch (e) { /* ignore */ }
    }
    if (state.reply && state.reply.cameraStream) {
      try { state.reply.cameraStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    }
    const field   = document.getElementById('replyCameraField');
    const preview = document.getElementById('replyCameraPreview');
    if (preview) { try { preview.pause(); } catch (e) { /* ignore */ } preview.srcObject = null; }
    if (field) field.hidden = true;
    if (state.reply) {
      state.reply.cameraMode = null;
      state.reply.cameraStream = null;
      state.reply.cameraRecorder = null;
      state.reply.cameraChunks = [];
    }
  }

  // ---------------- Helpers ----------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  // The server stores reply media at /media/<file> on the API host
  // (port 3000). The Student page is served from a different port
  // (e.g. 8001), so a server-relative URL like "/media/x.webm" would
  // 404. Always route media through the API origin.
  function mediaUrl(url) {
    const s = String(url || '');
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return API_BASE + s;
    return API_BASE + '/' + s;
  }
  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  }
  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  }
  function friendlyDate(yyyymmdd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || '');
    if (!m) return 'Today';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function fmtScore(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
  }
  function friendlyTimeAgo(ts) {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  function friendlyAwardDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function showSnackbar(message) {
    const el = $('#snackbar');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showSnackbar._t);
    showSnackbar._t = setTimeout(() => {
      el.hidden = true;
      state.snackbar = null;
    }, 2400);
  }

  // ---------------- Reactive ----------------
  const subscribers = new Set();
  function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  function notify() { subscribers.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }
  function update(mutator) { mutator(state); notify(); }

  // ---------------- Actions ----------------
  const actions = {
    loadPoints() {
      if (!state.username) return Promise.resolve();
      update(s => { s.points.loading = true; s.points.error = false; });
      return fetch(API_BASE + '/api/students/' + encodeURIComponent(state.username) + '/points', { cache: 'no-store' })
        .then(res => {
          if (res.status === 404) {
            // No points yet — show zeros. This is normal, not an error.
            return { score: 0, awardCount: 0, lastAwardedAt: null, history: [] };
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          update(s => {
            s.points.score         = Number(data.score)         || 0;
            s.points.awardCount    = Number(data.awardCount)    || 0;
            s.points.lastAwardedAt = data.lastAwardedAt || null;
            s.points.loading       = false;
            s.points.loaded        = true;
          });
        })
        .catch(err => {
          console.warn('loadPoints failed:', err);
          update(s => {
            s.points.loading = false;
            s.points.error   = true;
            s.points.loaded  = true;
          });
        });
    },

    loadChallenge() {
      if (!state.username) return Promise.resolve();
      update(s => { s.challenge.loading = true; s.challenge.error = null; });
      return fetch(API_BASE + '/api/challenge', { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          update(s => {
            s.challenge.date = data.date || '';
            s.challenge.text = data.text || '';
            s.challenge.loading = false;
          });
          // Then the per-user done marker.
          return fetch(API_BASE + '/api/challenge/done?username=' + encodeURIComponent(state.username), { cache: 'no-store' });
        })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(done => {
          update(s => {
            s.challenge.done   = !!done.done;
            s.challenge.doneAt = done.doneAt || null;
          });
        })
        .catch(err => {
          console.warn('loadChallenge failed:', err);
          update(s => {
            s.challenge.loading = false;
            s.challenge.error   = "Couldn't reach the server.";
          });
        });
    },

    openWelcome() { update(s => { s.welcomeDialog = true; }); },
    closeWelcome() {
      try { sessionStorage.setItem(WELCOME_KEY, '1'); } catch (err) { /* ignore */ }
      update(s => { s.welcomeDialog = false; });
    },

    // ---------------- Read-only gradebook drawer ----------------
    // The student opens the hamburger to see the leaderboard and a
    // peer's stats. No edit / award / rename / delete — purely a view.
    openGradebook() {
      update(s => { s.gradebook.open = true; });
      // Lazily fetch the roster the first time, then cache it for the
      // rest of the tab session. Re-openings of the drawer are instant.
      if (!state.gradebook.students.length && !state.gradebook.loading) {
        return this.loadGradebook();
      }
      return Promise.resolve();
    },
    closeGradebook() {
      update(s => {
        s.gradebook.open = false;
        // Closing the parent also closes any open child detail drawer.
        s.gradebook.detail = { open: false, username: null, loading: false, error: null, data: null };
      });
    },
    loadGradebook() {
      update(s => { s.gradebook.loading = true; s.gradebook.error = null; });
      return fetch(API_BASE + '/api/students', { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const rows = Array.isArray(data && data.students) ? data.students : [];
          const clean = rows
            .map(r => ({
              username: String(r.username || '').trim(),
              id: String(r.id || ''),
              createdAt: r.createdAt || null,
            }))
            .filter(r => r.username)
            .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
          update(s => {
            s.gradebook.students = clean;
            s.gradebook.loading = false;
            s.gradebook.error = null;
          });
        })
        .catch(err => {
          console.warn('loadGradebook failed:', err);
          update(s => {
            s.gradebook.loading = false;
            s.gradebook.error = "Couldn't reach the server.";
          });
        });
    },
    openStudentDetail(username) {
      const u = String(username || '').trim();
      if (!u) return Promise.resolve();
      update(s => {
        s.gradebook.detail = { open: true, username: u, loading: true, error: null, data: null };
      });
      return this.loadStudentDetail(u);
    },
    closeStudentDetail() {
      update(s => {
        s.gradebook.detail = { open: false, username: null, loading: false, error: null, data: null };
      });
    },
    loadStudentDetail(username) {
      return fetch(API_BASE + '/api/students/' + encodeURIComponent(username) + '/points', { cache: 'no-store' })
        .then(res => {
          if (res.status === 404) {
            return { score: 0, awardCount: 0, lastAwardedAt: null, history: [] };
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          update(s => {
            s.gradebook.detail.loading = false;
            s.gradebook.detail.data = {
              score: Number(data.score) || 0,
              awardCount: Number(data.awardCount) || 0,
              lastAwardedAt: data.lastAwardedAt || null,
              history: Array.isArray(data.history) ? data.history : [],
            };
          });
        })
        .catch(err => {
          console.warn('loadStudentDetail failed:', err);
          update(s => {
            s.gradebook.detail.loading = false;
            s.gradebook.detail.error = "Couldn't reach the server.";
          });
        });
    },

    // ---------------- Edit username (student-driven, server-side) ----------------
    openEditUsername() {
      update(s => {
        s.editUsername = { open: true, saving: false, error: null };
      });
      // Prefill the form on next render.
      const cur = $('#editUsernameCurrent');
      if (cur) cur.textContent = state.username || '—';
      const input = $('#editUsernameInput');
      const pin   = $('#editUsernamePin');
      const err   = $('#editUsernameError');
      if (input) input.value = '';
      if (pin)   pin.value = '';
      if (err)   { err.hidden = true; err.textContent = ''; }
    },
    closeEditUsername() {
      update(s => { s.editUsername = { open: false, saving: false, error: null }; });
    },
    saveEditUsername(newName, pin) {
      const trimmed = String(newName || '').trim();
      const cleanPin = String(pin || '').trim();
      if (trimmed.length < 3) {
        update(s => { s.editUsername.error = 'New username must be at least 3 characters.'; });
        renderEditUsernameError('New username must be at least 3 characters.');
        return Promise.resolve();
      }
      if (!/^\d{6}$/.test(cleanPin)) {
        update(s => { s.editUsername.error = 'PIN must be 6 digits.'; });
        renderEditUsernameError('PIN must be 6 digits.');
        return Promise.resolve();
      }
      if (trimmed.toLowerCase() === String(state.username || '').toLowerCase()) {
        update(s => { s.editUsername.error = "That's already your username."; });
        renderEditUsernameError("That's already your username.");
        return Promise.resolve();
      }
      update(s => { s.editUsername.saving = true; s.editUsername.error = null; });
      renderEditUsernameError(null);

      return fetch(API_BASE + '/api/rename-username', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldUsername: state.username,
          newUsername: trimmed,
          pin: cleanPin,
        }),
      })
        .then(res => res.json().then(j => ({ ok: res.ok, status: res.status, j })))
        .then(({ ok, status, j }) => {
          if (!ok) {
            const msg = (j && j.error) || "Couldn't update. Try again.";
            update(s => {
              s.editUsername.saving = false;
              s.editUsername.error  = msg;
            });
            renderEditUsernameError(msg);
            if (status === 401) showSnackbar("Wrong PIN. Try again.");
            return;
          }
          // Adopt the new username client-side and update the URL so the
          // page keeps working without a reload.
          const newName = (j && j.username) ? String(j.username) : trimmed;
          try {
            const u = new URL(window.location.href);
            u.searchParams.set('u', newName);
            history.replaceState({}, '', u.toString());
          } catch (err) { /* ignore */ }
          update(s => {
            s.username = newName;
            s.editUsername = { open: false, saving: false, error: null };
            s.snackbar = { id: Date.now(), message: 'Username updated. Sign in next time with the new name.' };
          });
          showSnackbar('Username updated. Sign in next time with the new name.');
          // Refresh the points card with the new identity, and re-fetch
          // the gradebook roster so the renamed student shows up.
          actions.loadPoints();
          if (state.gradebook.open) actions.loadGradebook();
        })
        .catch(err => {
          console.warn('saveEditUsername failed:', err);
          update(s => {
            s.editUsername.saving = false;
            s.editUsername.error  = "Couldn't reach the server.";
          });
          renderEditUsernameError("Couldn't reach the server.");
        });
    },

    // ---------------- Content (notifications + messages + custom challenges) + archive ----------------
    // GET /api/content?username=<us>  — the server records a view for
    // every active notification on this call, so the act of polling
    // is the view event. Returns { active, archive, studentArchive, now }.
    // The first `daily-challenge` row in `active` is also folded into
    // `state.challenge` so the existing "Today's Challenge" card on
    // the student page keeps working without a parallel code path.
    loadContent() {
      if (!state.username) return Promise.resolve();
      update(s => { s.content.loading = true; s.content.error = null; });
      return fetch(API_BASE + '/api/content?username=' + encodeURIComponent(state.username), { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const active  = Array.isArray(data && data.active)  ? data.active  : [];
          const archive = Array.isArray(data && data.archive) ? data.archive : [];
          const sa      = Array.isArray(data && data.studentArchive) ? data.studentArchive : [];
          // Fold the daily-challenge row into state.challenge. The
          // server already orders active so the daily one is last in
          // the challenge bucket; find by kind.
          const daily = active.find(a => a && (a.kind === 'daily-challenge' || a.kind === 'new-challenge'));
          const others = active.filter(a => a && a !== daily);
          update(s => {
            if (daily) {
              s.challenge.text = String(daily.text || '');
              s.challenge.id   = String(daily.id   || '');
              s.challenge.kind = String(daily.kind || '');
              s.challenge.returnType = (daily.returnType === null || daily.returnType === undefined)
                ? null
                : String(daily.returnType);
              // Derive the YYYY-MM-DD date the challenge was posted on
              // from its `createdAt` ms-timestamp. This is what the
              // existing `friendlyDate()` helper expects.
              if (daily.createdAt) {
                const d = new Date(daily.createdAt);
                if (!isNaN(d.getTime())) {
                  const y = d.getFullYear();
                  const m = (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
                  const dd = (d.getDate() < 10 ? '0' : '') + d.getDate();
                  s.challenge.date = `${y}-${m}-${dd}`;
                }
              }
            } else {
              // No active challenge of either kind. Reset the
              // challenge id/kind so the Submit button hides.
              s.challenge.id = '';
              s.challenge.kind = '';
              s.challenge.returnType = null;
            }
            s.content.active = others;
            s.archive.items = archive;
            s.archive.studentItems = sa;
            s.content.loading = false;
            s.content.error = null;
          });
        })
        .catch(err => {
          console.warn('loadContent failed:', err);
          update(s => {
            s.content.loading = false;
            s.content.error = "Couldn't reach the server.";
          });
        });
    },
    openArchive() {
      update(s => { s.archive.open = true; });
      // Refresh the archive list on every open — the teacher may have
      // manually archived something since the last poll. Also
      // refresh the "my past replies" list so the date-grouped
      // entries show up to date.
      actions.loadAllMyReplies();
      return actions.loadContent();
    },
    closeArchive() {
      update(s => { s.archive.open = false; });
    },
    setArchiveTab(tab) {
      // No-op: the archive drawer no longer has tabs.
      void tab;
    },

    // ---------------- Reply dialog (challenge + message) ----------------
    // Open the reply dialog for a given parent. `parent` is an object
    // with { id, kind, returnType? } — the challenge/message we're
    // replying to. For messages, the field set is always text + audio
    // (no file upload). For challenges, the field set is driven by
    // the challenge's returnType. The dialog supports filling one,
    // both, or (when both fields are optional) just text.
    openReply(parent) {
      if (!parent || !parent.id || !state.username) return;
      // Tear down any prior audio object URL so we don't leak memory.
      if (state.reply.audioUrl) {
        try { URL.revokeObjectURL(state.reply.audioUrl); } catch (e) { /* ignore */ }
      }
      if (state.reply.mediaUrl) {
        try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (e) { /* ignore */ }
      }
      update(s => {
        s.reply = {
          open: true,
          parent: { id: String(parent.id), kind: String(parent.kind || 'challenge'),
                    returnType: parent.returnType || null },
          saving: false, error: null,
          text: '', mediaFile: null, mediaUrl: null,
          audioBlob: null, audioUrl: null, recording: false,
          required: { text: false, image: false, video: false, audio: false },
          cameraMode: null, cameraStream: null, cameraRecorder: null, cameraChunks: [],
        };
      });
      // The file input keeps the prior file across opens on most
      // browsers — clear every input (image library/camera, video
      // library/camera, legacy media) explicitly so the user starts
      // fresh, and hide the previews.
      const inputIds = ['replyMedia',
                        'replyImageLibrary', 'replyImageCamera',
                        'replyVideoLibrary', 'replyVideoCamera'];
      for (const id of inputIds) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      }
      // Hide + clear previews.
      const imgPrevWrap = document.getElementById('replyImagePreviewWrap');
      const imgPrev = document.getElementById('replyImagePreview');
      if (imgPrev) imgPrev.removeAttribute('src');
      if (imgPrevWrap) imgPrevWrap.hidden = true;
      const vidPrevWrap = document.getElementById('replyVideoPreviewWrap');
      const vidPrev = document.getElementById('replyVideoPreview');
      if (vidPrev) {
        try { vidPrev.pause(); } catch (e) { /* ignore */ }
        vidPrev.removeAttribute('src');
        vidPrev.load && vidPrev.load();
      }
      if (vidPrevWrap) vidPrevWrap.hidden = true;
      const txtEl = $('#replyText');
      if (txtEl) txtEl.value = '';
      const errEl = $('#replyError');
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      const audPrev = $('#replyAudioPreview');
      if (audPrev) { audPrev.hidden = true; audPrev.removeAttribute('src'); }
      const audStatus = $('#replyAudioStatus');
      if (audStatus) audStatus.textContent = 'No recording yet';
      const stopBtn = $('#replyAudioStopBtn');
      if (stopBtn) stopBtn.hidden = true;
      const recBtn = $('#replyAudioRecordBtn');
      if (recBtn) recBtn.hidden = false;
    },
    closeReply() {
      // Stop any active MediaRecorder before closing. The blob (if
      // any) is discarded — the user can record again next time.
      _stopMediaRecorder();
      _stopCamera();  // also kill any live camera + MediaRecorder
      if (state.reply.audioUrl) {
        try { URL.revokeObjectURL(state.reply.audioUrl); } catch (e) { /* ignore */ }
      }
      if (state.reply.mediaUrl) {
        try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (e) { /* ignore */ }
      }
      update(s => {
        s.reply = { open: false, parent: null, saving: false, error: null,
                    text: '', mediaFile: null, mediaUrl: null,
                    audioBlob: null, audioUrl: null, recording: false,
                    required: { text: false, image: false, video: false, audio: false },
                    cameraMode: null, cameraStream: null, cameraRecorder: null, cameraChunks: [] };
      });
    },
    submitReply() {
      if (!state.reply.open || !state.reply.parent) return Promise.resolve();
      const r = state.reply;
      // Validate against the required map set by renderDialogs() based
      // on the parent's returnType. If the teacher asked for a video,
      // a video is required; if they asked for text, a text reflection
      // is required; messages are all-optional. The student can always
      // add MORE (e.g. a video + an optional note) but the required
      // piece must be present.
      const req = r.required || { text: false, image: false, video: false, audio: false };
      const showError = (msg) => {
        update(s => { s.reply.error = msg; });
        const errEl = $('#replyError');
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      };
      const text  = String(r.text || '').trim();
      const hasImage = !!(r.mediaFile && String(r.mediaFile.type || '').toLowerCase().startsWith('image/'));
      const hasVideo = !!(r.mediaFile && String(r.mediaFile.type || '').toLowerCase().startsWith('video/'));
      const hasAudio = !!r.audioBlob ||
                       !!(r.mediaFile && String(r.mediaFile.type || '').toLowerCase().startsWith('audio/'));
      if (req.image && !hasImage) { showError('Your teacher asked for an image — add one before sending.'); return Promise.resolve(); }
      if (req.video && !hasVideo) { showError('Your teacher asked for a video — add one before sending.'); return Promise.resolve(); }
      if (req.audio && !hasAudio) { showError('Your teacher asked for an audio recording — record or upload one before sending.'); return Promise.resolve(); }
      if (req.text  && !text)     { showError('Write a reflection before sending.'); return Promise.resolve(); }
      // And if nothing is filled in at all (everything optional, but
      // the student didn't add anything), still block.
      if (!text && !r.mediaFile && !r.audioBlob) {
        showError('Add a note, a file, or a recording before sending.');
        return Promise.resolve();
      }
      // Decide the mediaType for the multipart upload. The server
      // validates this against the parent's allowed list.
      let mediaType = null;
      if (r.mediaFile) {
        const mt = String(r.mediaFile.type || '').toLowerCase();
        if (mt.startsWith('image/')) mediaType = 'image';
        else if (mt.startsWith('video/')) mediaType = 'video';
        else if (mt.startsWith('audio/')) mediaType = 'audio';
        else mediaType = 'text';  // server will 400 if not allowed
      } else if (r.audioBlob) {
        mediaType = 'audio';
      } else {
        mediaType = 'text';
      }

      const fd = new FormData();
      fd.append('parentId', r.parent.id);
      fd.append('parentKind', r.parent.kind);
      fd.append('studentUsername', state.username);
      if (r.text)        fd.append('text', r.text);
      if (mediaType)     fd.append('mediaType', mediaType);
      if (r.mediaFile)   fd.append('media', r.mediaFile, r.mediaFile.name || 'upload');
      if (r.audioBlob)   fd.append('media', r.audioBlob, 'recording.webm');

      update(s => { s.reply.saving = true; s.reply.error = null; });
      const errEl = $('#replyError');
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

      return fetch(API_BASE + '/api/replies', {
        method: 'POST',
        cache: 'no-store',
        body: fd,  // no Content-Type — browser sets the multipart boundary
      })
        .then(res => res.json().then(j => ({ ok: res.ok, j, status: res.status })))
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 413
              ? 'File too large — keep it under 15 MB.'
              : status === 429
                ? 'Slow down a moment — try again in a few seconds.'
                : (j && j.error) || "Couldn't send your reply.";
            update(s => { s.reply.saving = false; s.reply.error = msg; });
            if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
            return;
          }
          update(s => {
            s.reply = { open: false, parent: null, saving: false, error: null,
                        text: '', mediaFile: null, mediaUrl: null,
                        audioBlob: null, audioUrl: null, recording: false };
            s.snackbar = { id: Date.now(), message: 'Reply sent.' };
          });
          showSnackbar('Reply sent.');
          // Refresh the parent's reply list so the student sees their
          // new reply in the "Your replies" list, and the all-replies
          // list (used by the archive drawer) so the new reply
          // appears there too.
          actions.loadMyReplies(r.parent.id);
          return actions.loadAllMyReplies();
        })
        .catch(err => {
          console.warn('submitReply failed:', err);
          const msg = "Couldn't reach the server.";
          update(s => { s.reply.saving = false; s.reply.error = msg; });
          if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        });
    },
    // Pull replies for a single parent. Used by the student page to
    // render "Your replies" under a message card.
    loadMyReplies(parentId) {
      if (!parentId) return Promise.resolve();
      return fetch(API_BASE + '/api/replies?parentId=' + encodeURIComponent(parentId), { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const items = Array.isArray(data && data.items) ? data.items : [];
          // Filter to the current student's replies only — the
          // server returns everyone's replies for that parent.
          const me = (state.username || '').toLowerCase();
          const mine = items.filter(r => String(r.studentUsername || '').toLowerCase() === me);
          update(s => { s.myReplies[parentId] = mine; });
        })
        .catch(err => {
          console.warn('loadMyReplies failed:', err);
        });
    },
    // Pull *every* reply the current student has ever sent, in a
    // single round-trip. Used by the archive drawer to render a
    // complete "my past replies" list with date headings — we don't
    // have to know the parent of each reply up front.
    loadAllMyReplies() {
      if (!state.username) return Promise.resolve();
      return fetch(API_BASE + '/api/replies?student=' + encodeURIComponent(state.username), { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const items = Array.isArray(data && data.items) ? data.items : [];
          update(s => { s.myRepliesAll = items; });
        })
        .catch(err => {
          console.warn('loadAllMyReplies failed:', err);
        });
    },
  };

  // Inline helper used by the Edit Username flow. Keeping it outside the
  // actions object so the render path doesn't double-fire a state update.
  function renderEditUsernameError(message) {
    const el = $('#editUsernameError');
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
  }

  // ---------------- Render ----------------
  function render() {
    renderIdentity();
    renderHero();
    renderChallenge();
    renderContent();
    renderArchive();
    renderGradebook();
    renderStudentDetail();
    renderDialogs();
    if (state.snackbar) showSnackbar(state.snackbar.message);
  }

  function renderContent() {
    // Renders the "More from your teacher" section. Each item is a
    // single card: notification vs message vs custom-challenge. Items
    // are already sorted newest-first by the server.
    const section = $('#moreContentSection');
    const listEl  = $('#moreContentList');
    if (!section || !listEl) return;
    const items = Array.isArray(state.content.active) ? state.content.active : [];
    if (!items.length) {
      section.hidden = true;
      listEl.innerHTML = '';
      return;
    }
    section.hidden = false;
    listEl.innerHTML = items.map(item => {
      if (item && item.kind === 'notification') return notificationCardHtml(item);
      if (item && item.kind === 'message')      return messageCardHtml(item);
      if (item && item.kind === 'new-challenge') return customChallengeCardHtml(item);
      return '';
    }).join('');
  }

  function notificationCardHtml(n) {
    const title = escapeHtml(String(n.title || 'Notification'));
    const body  = escapeHtml(String(n.body  || ''));
    const when  = n.createdAt ? escapeHtml(friendlyTimeAgo(n.createdAt)) : '';
    return `
      <article class="more-content-row more-content-row--notification" data-id="${escapeHtml(String(n.id || ''))}">
        <header class="more-content-row-head">
          <span class="more-content-row-eyebrow">NOTIFICATION</span>
          <span class="more-content-row-meta">${when}</span>
        </header>
        <h4 class="more-content-row-title">${title}</h4>
        <p class="more-content-row-body">${body}</p>
      </article>
    `;
  }

  function customChallengeCardHtml(c) {
    const text = escapeHtml(String(c.text || ''));
    const when = c.expiresAt ? `expires ${escapeHtml(friendlyTimeAgo(c.expiresAt))}` : '';
    // Every challenge now has a Submit button — even if the teacher
    // didn't set a return type, the dialog will just be text-only.
    // The label reflects the chosen return type, or defaults to
    // "Submit a reflection" for the text-only path.
    const submitLabel = (() => {
      switch (String(c.returnType || '')) {
        case 'image': return 'Submit a photo';
        case 'video': return 'Submit a video';
        case 'audio': return 'Submit a recording';
        case 'text':  return 'Submit a reflection';
        default:      return 'Submit a reflection';
      }
    })();
    const actionBtn = `<button class="btn btn-primary" type="button" data-reply-parent="challenge" data-reply-id="${escapeHtml(String(c.id || ''))}">${escapeHtml(submitLabel)}</button>`;
    return `
      <article class="more-content-row more-content-row--challenge" data-id="${escapeHtml(String(c.id || ''))}">
        <header class="more-content-row-head">
          <span class="more-content-row-eyebrow">CHALLENGE</span>
          <span class="more-content-row-meta">${when}</span>
        </header>
        <p class="more-content-row-body">${text}</p>
        <div class="more-content-row-actions">${actionBtn}</div>
      </article>
    `;
  }

  function messageCardHtml(m) {
    const title = escapeHtml(String(m.title || 'Message'));
    const body  = escapeHtml(String(m.body  || ''));
    const when  = m.createdAt ? escapeHtml(friendlyTimeAgo(m.createdAt)) : '';
    const id    = String(m.id || '');
    // Pull any past replies for this message from the cache. The
    // server returns everyone's replies per parent; the render only
    // shows this student's own. We lazy-load on first render so
    // signed-in students see their previous replies without delay.
    const myReplies = (state.myReplies && state.myReplies[id]) || [];
    const myRepliesHtml = myReplies.length
      ? `<div class="more-content-row-replies">
          <span class="more-content-row-replies-eyebrow">YOUR REPLIES</span>
          ${myReplies.slice().reverse().map(r => {
            const text = r.text ? `<p class="reply-bubble-text">${escapeHtml(String(r.text))}</p>` : '';
            const mediaUrl = mediaUrl(r.mediaUrl);
            const mediaType = String(r.mediaType || '');
            let media = '';
            if (mediaUrl) {
              if (mediaType === 'image' || /\.(jpe?g|png|gif|webp|bmp)$/i.test(mediaUrl)) {
                media = `<img class="reply-bubble-media" src="${escapeHtml(mediaUrl)}" alt="Reply image" />`;
              } else if (mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(mediaUrl)) {
                media = `<video class="reply-bubble-media" src="${escapeHtml(mediaUrl)}" controls preload="metadata"></video>`;
              } else if (mediaType === 'audio' || /\.(mp3|wav|ogg|m4a|webm)$/i.test(mediaUrl)) {
                media = `<audio class="reply-bubble-media" src="${escapeHtml(mediaUrl)}" controls preload="metadata"></audio>`;
              }
            }
            const at = r.createdAt ? escapeHtml(friendlyTimeAgo(r.createdAt)) : '';
            return `<div class="reply-bubble">${text}${media}<span class="reply-bubble-when">${at}</span></div>`;
          }).join('')}
        </div>`
      : '';
    return `
      <article class="more-content-row more-content-row--message" data-id="${escapeHtml(id)}">
        <header class="more-content-row-head">
          <span class="more-content-row-eyebrow">MESSAGE</span>
          <span class="more-content-row-meta">${when}</span>
        </header>
        <h4 class="more-content-row-title">${title}</h4>
        <p class="more-content-row-body">${body}</p>
        <div class="more-content-row-actions">
          <button class="btn btn-primary" type="button" data-reply-parent="message" data-reply-id="${escapeHtml(id)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
            </svg>
            Reply
          </button>
        </div>
        ${myRepliesHtml}
      </article>
    `;
  }

  function renderArchive() {
    // The archive drawer has two flavors of content, both sorted
    // newest-first:
    //   1. Server-side archive rows (notifications / challenges
    //      that have been archived either by the teacher or by the
    //      all-viewed sweep, plus per-student archive rows that the
    //      sign-out flow moved here).
    //   2. The student's *own past replies* — every text, audio,
    //      image, or video reply this student has ever sent to a
    //      challenge or message. These are grouped by date with a
    //      date heading, then each reply is prefixed with
    //      "Replied to: <parent title>".
    //
    // The two lists are interleaved by date so the student sees
    // everything that happened on a given day in one block, with
    // the date only on the heading (per the user's spec).
    const ctx = $('#archiveContext');
    const listEl = $('#archiveList');
    if (!ctx || !listEl) return;

    const archived = Array.isArray(state.archive.items) ? state.archive.items : [];
    const myReplies = Array.isArray(state.myRepliesAll) ? state.myRepliesAll : [];

    // Build a quick lookup from parentId → { kind, title, body }
    // so we can label each reply with the thing it was a reply
    // to. The challenge is in `state.challenge`; messages and
    // new-challenges are in `state.content.active`.
    const parentIdx = {};
    if (state.challenge && state.challenge.id) {
      parentIdx[String(state.challenge.id)] = {
        kind: 'daily-challenge',
        title: (state.challenge.text || '').slice(0, 80) || "Today's challenge",
      };
    }
    if (Array.isArray(state.content && state.content.active)) {
      for (const a of state.content.active) {
        if (!a || !a.id) continue;
        const k = String(a.id);
        if (a.kind === 'message') {
          parentIdx[k] = { kind: 'message', title: a.title || 'Message' };
        } else if (a.kind === 'new-challenge') {
          parentIdx[k] = { kind: 'new-challenge', title: (a.text || '').slice(0, 80) || 'New challenge' };
        }
      }
    }

    if (state.archive.loading && !archived.length && !myReplies.length) {
      ctx.textContent = 'Loading…';
      listEl.innerHTML = `<div class="drawer-row-empty">Loading…</div>`;
      return;
    }
    if (!archived.length && !myReplies.length) {
      ctx.textContent = 'Your archive is empty. Viewed notifications and your past replies will show up here.';
      listEl.innerHTML = `<div class="drawer-row-empty">Nothing here yet.</div>`;
      return;
    }

    // Total count for the context line — include both flavors.
    const total = archived.length + myReplies.length;
    ctx.textContent = `${total} archived item${total === 1 ? '' : 's'} · newest first.`;

    // Build the unified, date-sorted list. Each entry is either an
    // "archived" item or a "reply" item, both with a `when` ms
    // timestamp so we can sort + group by day.
    const entries = [];
    for (const a of archived) {
      const when = Number(a.archivedAt || a.createdAt || 0);
      entries.push({ kind: 'archived', when, raw: a });
    }
    for (const r of myReplies) {
      const when = Number(r.createdAt || 0);
      entries.push({ kind: 'reply', when, raw: r });
    }
    entries.sort((x, y) => (y.when || 0) - (x.when || 0));

    // Group consecutive entries that share the same local-day key
    // (YYYY-MM-DD). Each group is rendered with a date heading,
    // then a list of rows beneath it. The heading is the *first*
    // time we see that day, so the date isn't repeated on every
    // row (per the user's spec).
    function dayKey(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    }
    function formatDayHeading(ms) {
      const d = new Date(ms);
      // e.g. "June 20 2026" — the user explicitly wrote that
      // format, so we honor it literally.
      const month = d.toLocaleString(undefined, { month: 'long' });
      return `${month} ${d.getDate()} ${d.getFullYear()}`;
    }
    function formatClock(ms) {
      const d = new Date(ms);
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    let lastDay = '';
    const html = [];
    for (const e of entries) {
      const day = dayKey(e.when);
      if (day && day !== lastDay) {
        html.push(`<h3 class="archive-day-heading">${escapeHtml(formatDayHeading(e.when))}</h3>`);
        lastDay = day;
      }
      if (e.kind === 'archived') {
        html.push(archiveRowHtml(e.raw, formatClock(e.when)));
      } else {
        const parent = parentIdx[String(e.raw.parentId)] || {
          kind: e.raw.parentKind || 'unknown',
          title: '(Removed)',
        };
        html.push(replyRowHtml(e.raw, parent, formatClock(e.when)));
      }
    }
    listEl.innerHTML = html.join('');
  }

  function archiveRowHtml(a, clock) {
    const kind = String(a.kind || '');
    const title = escapeHtml(String(a.title || (kind === 'notification' ? 'Notification' : 'Challenge')));
    const bodyHtml = (kind === 'notification' || kind === 'message' || a.body)
      ? `<p class="archive-row-body">${escapeHtml(String(a.body || a.text || ''))}</p>`
      : `<p class="archive-row-body">${escapeHtml(String(a.text || ''))}</p>`;
    const reason = archiveReasonLabel(a.archiveReason);
    const when = a.archivedAt
      ? `archived ${escapeHtml(friendlyTimeAgo(a.archivedAt))}`
      : '';
    const clockStr = clock ? `<span class="archive-row-clock">${escapeHtml(clock)}</span>` : '';
    return `
      <article class="archive-row archive-row--${escapeHtml(kind)}">
        <div class="archive-row-head">
          <span class="archive-row-eyebrow">${escapeHtml(archiveKindLabel(kind))}</span>
          <span class="archive-row-meta">${escapeHtml(reason)}${when ? ' · ' + when : ''}${clockStr}</span>
        </div>
        <p class="archive-row-title">${title}</p>
        ${bodyHtml}
      </article>
    `;
  }

  function replyRowHtml(r, parent, clock) {
    const text = r.text
      ? `<p class="archive-row-body">${escapeHtml(String(r.text))}</p>`
      : '';
    const url = mediaUrl(r.mediaUrl);
    const mediaType = String(r.mediaType || '');
    let media = '';
    if (url) {
      if (mediaType === 'image' || /\.(jpe?g|png|gif|webp|bmp)$/i.test(url)) {
        media = `<img class="archive-row-media" src="${escapeHtml(url)}" alt="Reply image" />`;
      } else if (mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(url)) {
        media = `<video class="archive-row-media" src="${escapeHtml(url)}" controls preload="metadata"></video>`;
      } else if (mediaType === 'audio' || /\.(mp3|wav|ogg|m4a|webm)$/i.test(url)) {
        media = `<audio class="archive-row-media" src="${escapeHtml(url)}" controls preload="metadata"></audio>`;
      }
    }
    const parentLabel = String(parent.title || '(Removed)');
    const parentKindLabel = parent.kind === 'message' ? 'message' : 'challenge';
    const clockStr = clock ? `<span class="archive-row-clock">${escapeHtml(clock)}</span>` : '';
    // Layout:
    //   "YOUR REPLY" + clock on the head line
    //   "Replied to: <parent>" as the prominent title
    //   the reply text / media as the body
    return `
      <article class="archive-row archive-row--reply">
        <div class="archive-row-head">
          <span class="archive-row-eyebrow">YOUR REPLY</span>
          ${clockStr}
        </div>
        <p class="archive-row-title">Replied to: <strong>${escapeHtml(parentLabel)}</strong> <span class="archive-row-kind">(${escapeHtml(parentKindLabel)})</span></p>
        ${text}
        ${media}
      </article>
    `;
  }

  function archiveKindLabel(kind) {
    if (kind === 'notification')  return 'NOTIFICATION';
    if (kind === 'message')       return 'MESSAGE';
    if (kind === 'new-challenge') return 'NEW CHALLENGE';
    return "TODAY'S CHALLENGE";
  }
  function archiveReasonLabel(reason) {
    if (reason === 'expired')    return 'expired';
    if (reason === 'all-viewed') return 'everyone viewed';
    if (reason === 'manual')     return 'archived manually';
    if (reason === 'replaced')   return 'replaced';
    return '';
  }

  function renderIdentity() {
    if (!state.username) {
      $('#studentView').hidden = true;
      $('#notSignedIn').hidden = false;
      $('#signoutBtn').hidden = true;
      $('#brandSub').textContent = 'Sign in to see your circle.';
      return;
    }
    $('#studentView').hidden = false;
    $('#notSignedIn').hidden = true;
    $('#signoutBtn').hidden = false;
    $('#brandSub').textContent = 'Hi, ' + state.username;
  }

  function renderHero() {
    const name = state.username || '?';
    $('#heroAvatar').textContent = initials(name);
    $('#heroAvatar').style.background = avatarColor(name);
    $('#heroTitle').textContent = 'Hi, ' + name;
    if (state.points.error) {
      $('#heroSub').textContent = "Couldn't load your points. Check your connection.";
    } else if (!state.points.loaded) {
      $('#heroSub').textContent = 'Loading your points…';
    } else if (state.points.awardCount) {
      $('#heroSub').textContent = state.points.awardCount + ' award' + (state.points.awardCount === 1 ? '' : 's') + ' so far. Keep going.';
    } else {
      $('#heroSub').textContent = 'No awards yet — your teacher is on it.';
    }
    $('#scoreNum').textContent = fmtScore(state.points.score);
  }

  function renderChallenge() {
    const c = state.challenge;
    $('#challengeDate').textContent = c.date ? friendlyDate(c.date) : 'Today';
    const empty = $('#challengeEmpty');
    const set   = $('#challengeSet');
    const done  = $('#challengeCompleted');

    if (!c.text) {
      empty.hidden = false;
      set.hidden   = true;
      done.hidden  = true;
      if (c.loading) {
        // Replace the lede to indicate we're still waiting.
        $('#challengeLede').textContent = "Checking what's on for today…";
      } else if (c.error) {
        $('#challengeLede').textContent = c.error;
      } else {
        $('#challengeLede').textContent = "Your teacher hasn't set a challenge for today yet.";
      }
      return;
    }
    empty.hidden = true;
    $('#challengeLede').textContent = 'From your teacher, just for today.';

    // The card is "completed" when this student has already posted
    // at least one reply to this challenge. The lookup is by parent
    // id + parent kind so replies to a different challenge don't
    // accidentally mark this one as done.
    const alreadyReplied = !!(c.id && Array.isArray(state.myRepliesAll) &&
      state.myRepliesAll.some(r =>
        String(r.parentId) === String(c.id) &&
        String(r.parentKind) === 'challenge'
      ));
    if (alreadyReplied) {
      done.hidden = false;
      set.hidden  = true;
      $('#challengeTextDone').textContent = c.text;
      return;
    }
    set.hidden  = false;
    done.hidden = true;
    $('#challengeText').textContent = c.text;

    // The Submit button is the ONLY primary action. The label reflects
    // the return type when the teacher set one; otherwise we use the
    // text-only default (the dialog will only show the text field).
    const submitBtn = $('#challengeSubmit');
    const submitLabel = $('#challengeSubmitLabel');
    if (submitBtn) submitBtn.hidden = false;
    if (submitLabel) {
      const rt = c.returnType;
      submitLabel.textContent = (() => {
        switch (rt) {
          case 'image': return 'Submit a photo';
          case 'video': return 'Submit a video';
          case 'audio': return 'Submit a recording';
          case 'text':  return 'Submit a reflection';
          default:      return 'Submit a reflection';
        }
      })();
    }
  }

  function renderDialogs() {
    $('#welcomeDialog').hidden = !state.welcomeDialog;
    $('#gradebookDrawer').hidden = !state.gradebook.open;
    $('#studentDetailDrawer').hidden = !state.gradebook.detail.open;
    $('#editUsernameDialog').hidden = !state.editUsername.open;
    $('#archiveDrawer').hidden = !state.archive.open;
    $('#replyDialog').hidden = !state.reply.open;
    // Configure the reply dialog's field visibility + required-ness
    // based on the parent's expected media type.
    //
    //   - Messages: text + image + video + audio, all optional. The
    //     student can send any combination — text only, an image only,
    //     a video only, a recording only, or any mix of the above.
    //     Nothing is required; the student can also send nothing but
    //     the dialog's submit-time check requires at least one part.
    //   - Challenge with returnType = "text": only the text field,
    //     and it is required (it's the whole point of the challenge).
    //   - Challenge with returnType = image / video / audio: only the
    //     matching media field is shown, and it is REQUIRED. Text is
    //     still allowed (a note alongside the media) but is optional.
    //   - Challenge with no returnType: text-only, required.
    //
    // We track the requirement via a small `required` object on
    // `state.reply` so the submit handler can validate.
    if (state.reply.open && state.reply.parent) {
      const isMsg = state.reply.parent.kind === 'message';
      const rt = state.reply.parent.returnType;
      const imageField = $('#replyImageField');
      const videoField = $('#replyVideoField');
      const audioField = $('#replyAudioField');
      const imageLabel = $('#replyImageLabel');
      const videoLabel = $('#replyVideoLabel');
      const audioLabel = $('#replyAudioLabel');
      const textLabel  = $('#replyTextLabel');
      // Reset required map each render; the submit handler reads
      // state.reply.required to know what to validate.
      state.reply.required = { text: false, image: false, video: false, audio: false };
      if (isMsg) {
        // Messages: every field is available, none required. The
        // student can fill in any of text / image / video / audio
        // (or any combination) before sending.
        if (imageField) imageField.hidden = false;
        if (videoField) videoField.hidden = false;
        if (audioField) audioField.hidden = false;
        if (imageLabel) imageLabel.textContent = 'Add an image (optional)';
        if (videoLabel) videoLabel.textContent = 'Add a video (optional)';
        if (audioLabel) audioLabel.textContent = 'Record an audio message (optional)';
        if (textLabel)  textLabel.textContent  = 'Your reply (text)';
      } else if (rt === 'text') {
        if (imageField) imageField.hidden = true;
        if (videoField) videoField.hidden = true;
        if (audioField) audioField.hidden = true;
        if (textLabel)  textLabel.textContent  = 'Your reflection (required)';
        state.reply.required.text = true;
      } else if (rt === 'audio') {
        if (imageField) imageField.hidden = true;
        if (videoField) videoField.hidden = true;
        if (audioField) audioField.hidden = false;
        if (audioLabel) audioLabel.textContent = 'Record an audio message (required)';
        if (textLabel)  textLabel.textContent  = 'Your reply (text) — optional note';
        state.reply.required.audio = true;
      } else if (rt === 'image') {
        if (imageField) imageField.hidden = false;
        if (videoField) videoField.hidden = true;
        if (audioField) audioField.hidden = true;
        if (imageLabel) imageLabel.textContent = 'Add an image (required)';
        if (textLabel)  textLabel.textContent  = 'Your reply (text) — optional note';
        state.reply.required.image = true;
      } else if (rt === 'video') {
        if (imageField) imageField.hidden = true;
        if (videoField) videoField.hidden = false;
        if (audioField) audioField.hidden = true;
        if (videoLabel) videoLabel.textContent = 'Add a video (required)';
        if (textLabel)  textLabel.textContent  = 'Your reply (text) — optional note';
        state.reply.required.video = true;
      } else {
        // Unknown returnType — defensively default to text-only
        // (no image, no video, no audio) and require the text so
        // the student can't send an empty reply.
        if (imageField) imageField.hidden = true;
        if (videoField) videoField.hidden = true;
        if (audioField) audioField.hidden = true;
        if (textLabel)  textLabel.textContent  = 'Your reflection (required)';
        state.reply.required.text = true;
      }
      // Update the dialog context line + title.
      const ctx = $('#replyDialogContext');
      const title = $('#replyDialogTitle');
      if (isMsg) {
        if (ctx)   ctx.textContent = 'Reply with any combination of text, an image, a video, or an audio recording. Nothing is required — but you need to include at least one before sending.';
        if (title) title.textContent = 'Reply';
      } else if (rt === 'text') {
        if (ctx)   ctx.textContent = 'Type your reflection on the challenge.';
        if (title) title.textContent = "Today's challenge";
      } else if (rt === 'image' || rt === 'video' || rt === 'audio') {
        const typeName = ({ image: 'an image', video: 'a video', audio: 'a recording' })[rt];
        if (ctx)   ctx.textContent = `Your teacher asked for ${typeName}. You can also type a note.`;
        if (title) title.textContent = 'Submit your reply';
      } else {
        if (ctx)   ctx.textContent = 'Type your reply.';
        if (title) title.textContent = 'Submit your reply';
      }
    }
    const saveBtn = $('#editUsernameSaveBtn');
    if (saveBtn) saveBtn.disabled = !!state.editUsername.saving;
    const replySave = $('#replySubmitBtn');
    if (replySave) {
      replySave.disabled = !!state.reply.saving;
      replySave.textContent = state.reply.saving ? 'Sending…' : 'Send reply';
    }
  }

  function renderGradebook() {
    const g = state.gradebook;
    const context = $('#gradebookContext');
    const listEl  = $('#gradebookList');
    if (!context || !listEl) return;

    if (g.loading) {
      context.textContent = 'Loading the leaderboard…';
      listEl.innerHTML = `<div class="drawer-row-empty">Fetching students…</div>`;
      return;
    }
    if (g.error) {
      context.textContent = g.error;
      listEl.innerHTML = `<div class="drawer-row-empty">${escapeHtml(g.error)}</div>`;
      return;
    }
    if (!g.students.length) {
      context.textContent = 'No students have signed up yet.';
      listEl.innerHTML = `<div class="drawer-row-empty">No students yet.</div>`;
      return;
    }
    // Sort by name (the detail drawer pulls live scores on tap). A
    // simple alphabetical list is the most readable read-only view;
    // scores appear when a student is selected.
    const sorted = [...g.students].sort((a, b) =>
      a.username.localeCompare(b.username, undefined, { sensitivity: 'base' })
    );
    context.textContent = `${sorted.length} student${sorted.length === 1 ? '' : 's'} · tap one to see their points.`;

    listEl.innerHTML = sorted.map(s => {
      const color = avatarColor(s.username);
      const init  = initials(s.username);
      const safeName = escapeHtml(s.username);
      const safeInit  = escapeHtml(init);
      const safeColor = escapeHtml(color);
      return `
        <button class="drawer-row" type="button" data-action="openStudentDetail" data-username="${safeName}">
          <span class="drawer-row-avatar" style="background:${safeColor}">${safeInit}</span>
          <span class="drawer-row-text">
            <span class="drawer-row-name">${safeName}</span>
            <span class="drawer-row-meta">tap to view points</span>
          </span>
          <span class="drawer-row-score" aria-hidden="true">›</span>
        </button>
      `;
    }).join('');
  }

  function renderStudentDetail() {
    const d = state.gradebook.detail;
    const title = $('#studentDetailTitle');
    const ctx   = $('#studentDetailContext');
    const body  = $('#studentDetailList');
    if (!title || !ctx || !body) return;

    title.textContent = d.username || 'Student';
    if (d.loading) {
      ctx.textContent = 'Loading…';
      body.innerHTML = `<div class="drawer-row-empty">Fetching…</div>`;
      return;
    }
    if (d.error) {
      ctx.textContent = d.error;
      body.innerHTML = `<div class="drawer-row-empty">${escapeHtml(d.error)}</div>`;
      return;
    }
    if (!d.data) {
      ctx.textContent = '—';
      body.innerHTML = '';
      return;
    }
    const data = d.data;
    const lastLabel = data.lastAwardedAt ? friendlyTimeAgo(data.lastAwardedAt) : 'Never';
    ctx.textContent = `Read-only view · last awarded ${lastLabel}`;

    const events = Array.isArray(data.history) ? data.history.slice().sort((a, b) => b.at - a.at) : [];
    const recent = events.slice(0, 50); // cap the list for the drawer

    const historyHtml = !recent.length
      ? `<li class="history-row history-row-empty">No awards yet.</li>`
      : recent.map(ev => `
          <li class="history-row">
            <span class="history-row-date">${escapeHtml(friendlyAwardDate(ev.at))}</span>
            <span class="history-row-points">+${escapeHtml(fmtScore(ev.delta))}</span>
          </li>
        `).join('');

    body.innerHTML = `
      <div class="detail-stat-row">
        <span class="detail-stat-label">Score</span>
        <span class="detail-stat-value">${escapeHtml(fmtScore(data.score))}</span>
      </div>
      <div class="detail-stat-row">
        <span class="detail-stat-label">Awards</span>
        <span class="detail-stat-value">${escapeHtml(fmtScore(data.awardCount))}</span>
      </div>
      <div class="detail-stat-row">
        <span class="detail-stat-label">Last awarded</span>
        <span class="detail-stat-value">${escapeHtml(lastLabel)}</span>
      </div>
      <ul class="history-rows">${historyHtml}</ul>
    `;
  }

  // ---------------- Events ----------------
  function wireEvents() {
    // Sign out: clear the URL ?u= and reload the page so the user
    // lands on the "Sign in first" view. We used to redirect to
    // http://localhost:8001/ (the Login page), but that 1) only works
    // if the Login server is currently running, 2) punts the user
    // away from the Student app to a different origin, and 3) is
    // confusing if they want to sign in as someone else but the
    // Login window isn't open. Reloading with no ?u= is self-
    // contained: the page shows the "Sign in first" card with a
    // link to the Login page if they want it.
    // Sign out: clear the URL ?u= and reload the page so the user
    // lands on the "Sign in first" view. We also fire-and-forget a
    // POST /api/signout with `keepalive: true` so the server has a
    // chance to copy every active notification the student viewed
    // into their per-student archive before the page transitions.
    // `keepalive` lets the request survive the unload.
    $('#signoutBtn').addEventListener('click', () => {
      const u = state.username;
      if (u) {
        try {
          fetch(API_BASE + '/api/signout', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u }),
            keepalive: true,
          }).catch(() => {});
        } catch (err) { /* ignore */ }
      }
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('u');
        // Use replace() so the back button doesn't drop them back
        // into the signed-in view.
        window.location.replace(url.toString());
      } catch (err) {
        // Fall back to a hard reload of the same page.
        window.location.reload();
      }
    });

    // Hamburger → open the read-only gradebook drawer.
    $('#gradebookBtn').addEventListener('click', () => actions.openGradebook());

    // Archive icon (next to the hamburger) → open the archive drawer.
    $('#archiveBtn').addEventListener('click', () => actions.openArchive());

    // Archive drawer tabs (global / personal).
    document.querySelectorAll('.archive-tab').forEach(btn => {
      btn.addEventListener('click', () => actions.setArchiveTab(btn.dataset.archiveTab));
    });

    // Submit reply (the only primary action on the daily challenge now —
    // the legacy "Mark done" / "Reset" flow is gone; challenges are
    // always answered through the reply dialog, even when the teacher
    // didn't set a return type, in which case the dialog is text-only).
    $('#challengeSubmit').addEventListener('click', () => {
      const c = state.challenge;
      if (!c.id) return;
      // If the teacher didn't set a return type on this challenge,
      // we still go through the reply dialog, but the dialog is
      // text-only. Mapping null/empty to 'text' here is what makes
      // the dialog show just the text field (and no media pickers).
      const rt = c.returnType || 'text';
      actions.openReply({ id: c.id, kind: 'challenge', returnType: rt });
    });

    // Reply buttons on cards (challenge or message) — delegated.
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-reply-parent]');
      if (!t) return;
      const id   = t.dataset.replyId;
      const kind = t.dataset.replyParent;
      if (!id || !kind) return;
      // For a message kind, the reply always accepts text + audio
      // (returnType is null and the server allows those two).
      // For a challenge kind, look up the parent in state.content
      // so we can read its returnType; fall back to 'text' so the
      // dialog is at minimum a text-only reply.
      let returnType = null;
      if (kind === 'challenge') {
        const parent = (state.content && state.content.active || [])
          .find(x => String(x.id) === String(id) &&
                     (x.kind === 'daily-challenge' || x.kind === 'new-challenge'));
        returnType = (parent && parent.returnType) ? parent.returnType : 'text';
      }
      actions.openReply({ id, kind, returnType });
    });

    // Reply dialog: file input
    // Reply dialog: file inputs. The "Choose file" / "Take a pic" /
    // "Record video" buttons are plain <button>s that just trigger
    // the hidden <input type="file">. The change handler below
    // wires the picked file into state and shows the preview.
    document.querySelectorAll('[data-pick-image]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const target = btn.getAttribute('data-pick-image');  // "library" or "camera"
        if (target === 'camera') {
          _startCameraCapture('image');
        } else {
          const input = document.getElementById('replyImageLibrary');
          if (input) input.click();
        }
      });
    });
    document.querySelectorAll('[data-pick-video]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const target = btn.getAttribute('data-pick-video');  // "library" or "camera"
        if (target === 'camera') {
          _startCameraCapture('video');
        } else {
          const input = document.getElementById('replyVideoLibrary');
          if (input) input.click();
        }
      });
    });

    // Live-camera capture. Called when the student clicks "Take a
    // pic" or "Record video". Opens the device camera directly in
    // the page (instead of the OS file picker that `capture` would
    // trigger on mobile only) and either snaps a still frame
    // (image) or records a clip (video) and stores the resulting
    // Blob in `state.reply.mediaFile` so the rest of the dialog
    // (preview, submit, validation) treats it like a normal file.
    function _startCameraCapture(mode) {
      // mode is 'image' (still photo) or 'video' (clip).
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const fallbackInput = mode === 'image'
          ? document.getElementById('replyImageCamera')
          : document.getElementById('replyVideoCamera');
        if (fallbackInput) fallbackInput.click();
        return;
      }
      // Stop any prior session before starting a new one.
      _stopCamera();
      const constraints = mode === 'image'
        ? { video: { facingMode: 'environment' }, audio: false }
        : { video: { facingMode: 'environment' }, audio: true };
      navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
          const field   = document.getElementById('replyCameraField');
          const preview = document.getElementById('replyCameraPreview');
          const capture = document.getElementById('replyCameraCaptureBtn');
          const stop    = document.getElementById('replyCameraStopBtn');
          const cancel  = document.getElementById('replyCameraCancelBtn');
          const status  = document.getElementById('replyCameraStatus');
          const label   = document.getElementById('replyCameraLabel');
          if (label)   label.textContent = mode === 'image' ? 'Take a photo' : 'Record a video';
          if (capture) capture.hidden = mode !== 'image';
          if (stop)    stop.hidden    = mode !== 'video';
          if (preview) {
            preview.srcObject = stream;
            preview.muted = true;
            preview.play().catch(() => {});
          }
          if (field) field.hidden = false;
          if (status) status.textContent = mode === 'image'
            ? 'Frame the shot, then tap Capture.'
            : 'Recording… tap Stop when done.';
          state.reply.cameraMode = mode;
          state.reply.cameraStream = stream;
          if (mode === 'video') {
            // Start a MediaRecorder alongside the live preview.
            const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
              && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))
              ? 'video/webm;codecs=vp8,opus'
              : (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm'))
                ? 'video/webm' : '';
            const rec = mime ? new MediaRecorder(stream, { mimeType: mime })
                             : new MediaRecorder(stream);
            state.reply.cameraChunks = [];
            rec.addEventListener('dataavailable', e => {
              if (e.data && e.data.size) state.reply.cameraChunks.push(e.data);
            });
            rec.addEventListener('stop', () => {
              // Wrap the chunks in a Blob and route through the
              // same mediaFile path the file-picker uses.
              const blob = new Blob(state.reply.cameraChunks, {
                type: mime || 'video/webm',
              });
              _finalizeCapturedMedia(blob, mode, /*filename*/ 'recording.webm');
            });
            rec.start();
            state.reply.cameraRecorder = rec;
          } else {
            // Image mode: store the stream so the Capture button
            // can draw a still frame from the live <video>.
            state.reply.cameraRecorder = null;
          }
        })
        .catch(err => {
          console.warn('getUserMedia failed:', err);
          // Fall back to the file input so the student still has a path.
          const fallbackInput = mode === 'image'
            ? document.getElementById('replyImageCamera')
            : document.getElementById('replyVideoCamera');
          if (fallbackInput) fallbackInput.click();
        });
    }

    // After a live capture completes (image frame OR video clip
    // finishes recording), set the resulting Blob as the dialog's
    // current media — same shape as a file picked from disk.
    function _finalizeCapturedMedia(blob, mode, filename) {
      // Build a File from the Blob so the existing file-picker
      // pipeline (preview, submit, MIME check) all "just work".
      const file = new File([blob], filename, { type: blob.type || (mode === 'image' ? 'image/jpeg' : 'video/webm') });
      if (state.reply.mediaUrl) {
        try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (e) { /* ignore */ }
      }
      const url = URL.createObjectURL(file);
      update(s => {
        s.reply.mediaFile = file;
        s.reply.mediaUrl  = url;
      });
      // Show the matching preview block + content.
      if (mode === 'image') {
        const wrap = document.getElementById('replyImagePreviewWrap');
        const prev = document.getElementById('replyImagePreview');
        if (prev) prev.src = url;
        if (wrap) wrap.hidden = false;
      } else {
        const wrap = document.getElementById('replyVideoPreviewWrap');
        const prev = document.getElementById('replyVideoPreview');
        if (prev) {
          try { prev.pause(); } catch (e) { /* ignore */ }
          prev.src = url;
        }
        if (wrap) wrap.hidden = false;
      }
      // Tear down the live camera block (we already have the file).
      _stopCamera();
    }

    // Capture (image mode) / Stop (video mode) / Cancel buttons.
    const captureBtn = document.getElementById('replyCameraCaptureBtn');
    if (captureBtn) {
      captureBtn.addEventListener('click', () => {
        if (state.reply.cameraMode !== 'image') return;
        const preview = document.getElementById('replyCameraPreview');
        if (!preview || !preview.videoWidth) {
          // Camera hasn't produced a frame yet.
          const status = document.getElementById('replyCameraStatus');
          if (status) status.textContent = 'Camera is still warming up — try again in a second.';
          return;
        }
        const w = preview.videoWidth, h = preview.videoHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(preview, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (blob) _finalizeCapturedMedia(blob, 'image', 'photo.jpg');
        }, 'image/jpeg', 0.92);
      });
    }
    const stopCamBtn = document.getElementById('replyCameraStopBtn');
    if (stopCamBtn) {
      stopCamBtn.addEventListener('click', () => {
        if (state.reply.cameraMode !== 'video') return;
        if (state.reply.cameraRecorder) {
          try { state.reply.cameraRecorder.stop(); } catch (e) { /* ignore */ }
        }
        // The recorder's 'stop' handler will call _finalizeCapturedMedia.
      });
    }
    const cancelCamBtn = document.getElementById('replyCameraCancelBtn');
    if (cancelCamBtn) {
      cancelCamBtn.addEventListener('click', () => {
        _stopCamera();
      });
    }

    // Helper: a single source of truth for "user picked a new file".
    // We revoke any prior object URL, store the File, store the
    // object URL, and show the matching preview element.
    const handleReplyFile = (inputId, kind) => {
      const input = document.getElementById(inputId);
      if (!input) return;
      input.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (state.reply.mediaUrl) {
          try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (err) { /* ignore */ }
        }
        const url = f ? URL.createObjectURL(f) : null;
        update(s => {
          s.reply.mediaFile = f || null;
          s.reply.mediaUrl  = url;
        });
        if (kind === 'image') {
          const wrap = document.getElementById('replyImagePreviewWrap');
          const prev = document.getElementById('replyImagePreview');
          if (prev) prev.src = url || '';
          if (wrap) wrap.hidden = !f;
        } else if (kind === 'video') {
          const wrap = document.getElementById('replyVideoPreviewWrap');
          const prev = document.getElementById('replyVideoPreview');
          if (prev) {
            try { prev.pause(); } catch (err) { /* ignore */ }
            if (url) prev.src = url; else { prev.removeAttribute('src'); prev.load && prev.load(); }
          }
          if (wrap) wrap.hidden = !f;
        }
      });
    };
    handleReplyFile('replyImageLibrary', 'image');
    handleReplyFile('replyImageCamera',  'image');
    handleReplyFile('replyVideoLibrary', 'video');
    handleReplyFile('replyVideoCamera',  'video');

    // "Remove" buttons next to each preview.
    const clearImage = document.getElementById('replyImageClear');
    if (clearImage) {
      clearImage.addEventListener('click', () => {
        const lib = document.getElementById('replyImageLibrary');
        const cam = document.getElementById('replyImageCamera');
        if (lib) lib.value = '';
        if (cam) cam.value = '';
        if (state.reply.mediaUrl) {
          try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (err) { /* ignore */ }
        }
        const prev = document.getElementById('replyImagePreview');
        const wrap = document.getElementById('replyImagePreviewWrap');
        if (prev) prev.removeAttribute('src');
        if (wrap) wrap.hidden = true;
        update(s => { s.reply.mediaFile = null; s.reply.mediaUrl = null; });
      });
    }
    const clearVideo = document.getElementById('replyVideoClear');
    if (clearVideo) {
      clearVideo.addEventListener('click', () => {
        const lib = document.getElementById('replyVideoLibrary');
        const cam = document.getElementById('replyVideoCamera');
        if (lib) lib.value = '';
        if (cam) cam.value = '';
        if (state.reply.mediaUrl) {
          try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (err) { /* ignore */ }
        }
        const prev = document.getElementById('replyVideoPreview');
        const wrap = document.getElementById('replyVideoPreviewWrap');
        if (prev) {
          try { prev.pause(); } catch (err) { /* ignore */ }
          prev.removeAttribute('src');
          prev.load && prev.load();
        }
        if (wrap) wrap.hidden = true;
        update(s => { s.reply.mediaFile = null; s.reply.mediaUrl = null; });
      });
    }

    // Legacy single-file field — kept only so a stale selector
    // doesn't 404. Wire it to the same handler so a stuck reference
    // still updates state.
    const replyMedia = $('#replyMedia');
    if (replyMedia) {
      replyMedia.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (state.reply.mediaUrl) {
          try { URL.revokeObjectURL(state.reply.mediaUrl); } catch (err) { /* ignore */ }
        }
        const url = f ? URL.createObjectURL(f) : null;
        update(s => {
          s.reply.mediaFile = f || null;
          s.reply.mediaUrl  = url;
        });
      });
    }

    // Reply dialog: text input
    const replyText = $('#replyText');
    if (replyText) {
      replyText.addEventListener('input', e => {
        update(s => { s.reply.text = String(e.target.value || ''); });
      });
    }

    // Reply dialog: audio record
    const recBtn = $('#replyAudioRecordBtn');
    const stopBtn = $('#replyAudioStopBtn');
    const audStatus = $('#replyAudioStatus');
    const audPrev = $('#replyAudioPreview');
    if (recBtn) {
      recBtn.addEventListener('click', () => {
        if (state.reply.recording) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          update(s => { s.reply.error = 'Audio recording is not supported in this browser.'; });
          if (audStatus) audStatus.textContent = 'Not supported in this browser';
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(stream => {
            _activeRecorderChunks = [];
            // Pick the most widely-supported mime; fall back to the
            // browser's default if it's not honored.
            const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
              && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
              ? 'audio/webm;codecs=opus'
              : '';
            _activeRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            _activeRecorder.addEventListener('dataavailable', e => {
              if (e.data && e.data.size) _activeRecorderChunks.push(e.data);
            });
            _activeRecorder.addEventListener('stop', () => {
              try { stream.getTracks().forEach(t => t.stop()); } catch (err) { /* ignore */ }
              const blob = new Blob(_activeRecorderChunks, { type: 'audio/webm' });
              if (state.reply.audioUrl) {
                try { URL.revokeObjectURL(state.reply.audioUrl); } catch (err) { /* ignore */ }
              }
              const url = URL.createObjectURL(blob);
              update(s => {
                s.reply.recording = false;
                s.reply.audioBlob = blob;
                s.reply.audioUrl  = url;
              });
              if (audPrev) {
                audPrev.src = url;
                audPrev.hidden = false;
              }
              if (audStatus) audStatus.textContent = 'Recording ready — review below.';
              if (recBtn) recBtn.hidden = false;
              if (stopBtn) stopBtn.hidden = true;
            });
            _activeRecorder.start();
            update(s => { s.reply.recording = true; });
            if (audStatus) audStatus.textContent = 'Recording… tap Stop when done.';
            if (recBtn) recBtn.hidden = true;
            if (stopBtn) stopBtn.hidden = false;
          })
          .catch(err => {
            console.warn('getUserMedia failed:', err);
            update(s => { s.reply.error = "Couldn't access the microphone."; });
            if (audStatus) audStatus.textContent = "Couldn't access the microphone";
          });
      });
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        _stopMediaRecorder();
      });
    }

    // Reply dialog submit
    const replySubmit = $('#replySubmitBtn');
    if (replySubmit) replySubmit.addEventListener('click', () => actions.submitReply());

    // Edit username flow: open the dialog, save with PIN.
    $('#editUsernameBtn').addEventListener('click', () => actions.openEditUsername());
    $('#editUsernameSaveBtn').addEventListener('click', () => {
      const name = $('#editUsernameInput').value;
      const pin  = $('#editUsernamePin').value;
      actions.saveEditUsername(name, pin);
    });
    // Pressing Enter inside either input submits the form.
    const editSubmit = () => {
      const name = $('#editUsernameInput').value;
      const pin  = $('#editUsernamePin').value;
      actions.saveEditUsername(name, pin);
    };
    $('#editUsernameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); editSubmit(); }
    });
    $('#editUsernamePin').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); editSubmit(); }
    });

    // Generic close-on-X-button handler. The X buttons in every
    // dialog/drawer carry [data-close-dialog="<id>"] so this single
    // delegated handler can dismiss any of them.
    document.addEventListener('click', e => {
      const closeId = e.target.closest('[data-close-dialog]')?.dataset.closeDialog;
      if (closeId === 'gradebookDrawer')      actions.closeGradebook();
      else if (closeId === 'studentDetailDrawer')  actions.closeStudentDetail();
      else if (closeId === 'editUsernameDialog')   actions.closeEditUsername();
      else if (closeId === 'archiveDrawer')        actions.closeArchive();
      else if (closeId === 'replyDialog')          actions.closeReply();
    });
    // Welcome close: a direct click handler on the "Got it" CTA.
    // We previously relied on a document-level delegated handler plus
    // a per-element safety net — that wiring was fragile in the
    // presence of nested SVGs and conflicting stopPropagation calls
    // from other doc-level handlers, so the button would sometimes
    // not respond. A direct handler on the button itself is the
    // most reliable path: it fires regardless of bubbling, captures,
    // or any other event-shape weirdness in the surrounding stack.
    const welcomeCta = document.getElementById('welcomeCtaBtn');
    if (welcomeCta) {
      welcomeCta.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        actions.closeWelcome();
      });
    }
    // Clicking the dimmed backdrop (not the card itself) also closes.
    $('#welcomeDialog').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeWelcome();
    });
    // Backdrop click + Escape for the new dialogs/drawers.
    $('#gradebookDrawer').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeGradebook();
    });
    $('#studentDetailDrawer').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeStudentDetail();
    });
    $('#editUsernameDialog').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeEditUsername();
    });
    $('#archiveDrawer').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeArchive();
    });
    $('#replyDialog').addEventListener('click', e => {
      if (e.target === e.currentTarget) actions.closeReply();
    });
    // Escape closes too — top-most dialog first.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.reply.open)                      actions.closeReply();
      else if (state.archive.open)               actions.closeArchive();
      else if (state.editUsername.open)         actions.closeEditUsername();
      else if (state.gradebook.detail.open)    actions.closeStudentDetail();
      else if (state.gradebook.open)           actions.closeGradebook();
      else if (state.welcomeDialog)            actions.closeWelcome();
    });

    // Delegated handler: tapping a row in the gradebook drawer opens
    // the read-only detail drawer for that student.
    document.addEventListener('click', e => {
      const trigger = e.target.closest('[data-action="openStudentDetail"]');
      if (!trigger) return;
      const username = trigger.dataset.username;
      if (!username) return;
      actions.openStudentDetail(username);
    });
  }

  // ---------------- Init ----------------
  function init() {
    wireEvents();
    subscribe(render);
    render();

    if (state.username) {
      // Pull the three server-backed pieces in parallel — they're
      // independent. The mark-done button is hidden until the
      // challenge is loaded. The content fetch is what records a
      // "view" on each active notification server-side.
      actions.loadPoints();
      actions.loadChallenge();
      actions.loadContent().then(() => {
        // After the initial content fetch, lazy-load the student's
        // own past replies for every active message so the message
        // cards can show "Your replies" without a second poll.
        const msgs = (state.content && Array.isArray(state.content.active))
          ? state.content.active.filter(a => a && a.kind === 'message')
          : [];
        msgs.forEach(m => { if (m.id) actions.loadMyReplies(m.id); });
      });
      // Pull *all* of this student's replies (in one shot) for the
      // archive drawer's "my past replies" list. The reply list
      // doesn't change as often as the active content, so we poll
      // it on a separate, longer interval.
      actions.loadAllMyReplies();
      setInterval(() => actions.loadAllMyReplies(), 60 * 1000);

      // Keep the points + content in sync with the server while the
      // tab is open. Without this, an award made by the teacher on
      // their own tab wouldn't show up here until a manual reload,
      // and a notification would never auto-archive (since the
      // archive sweep runs on read). 20s is a good balance — slightly
      // faster than the teacher's poll so the student sees the new
      // points before the teacher has to ask.
      setInterval(() => {
        actions.loadPoints();
        actions.loadContent().then(() => {
          const msgs = (state.content && Array.isArray(state.content.active))
            ? state.content.active.filter(a => a && a.kind === 'message')
            : [];
          msgs.forEach(m => { if (m.id) actions.loadMyReplies(m.id); });
        });
      }, 20 * 1000);

      // First-visit welcome: same per-tab pattern as the teacher app.
      let hasSeenWelcome = false;
      try { hasSeenWelcome = sessionStorage.getItem(WELCOME_KEY) === '1'; } catch (err) { /* ignore */ }
      if (!hasSeenWelcome) actions.openWelcome();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

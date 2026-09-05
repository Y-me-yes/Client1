/* ============================================================
   1% Healthy Habit — Teacher Dashboard
   Vanilla JS reactive store + localStorage persistence.
   Mirrors the Android MVVM / UDF architecture:
     - State (single source of truth)
     - subscribe() -> re-render
     - actions()  -> mutate state -> persist -> re-render
   ============================================================ */

(function () {
  'use strict';

  // ---------------- Constants ----------------
  const STORAGE_KEY = 'healthy-habit.students.v1';
  const WELCOME_KEY  = 'healthy-habit.welcomed.v1';
  const LEGACY_STORAGE_KEY = 'sst.students.v1';
  const LEGACY_WELCOME_KEY = 'sst.welcomed.v1';
  const API_BASE     = ''; // same-origin: static files and API are served from the same host
  const AVATAR_PALETTE = ['#8B5CF6', '#10B981', '#F43F5E', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#6366F1'];

  // One-time migration from the old internal storage keys so existing teacher data is preserved.
  try {
    if (!localStorage.getItem(STORAGE_KEY)) {
      const legacyStudents = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyStudents) localStorage.setItem(STORAGE_KEY, legacyStudents);
    }
  } catch (err) { /* ignore storage migration errors */ }
  try {
    if (!sessionStorage.getItem(WELCOME_KEY)) {
      const legacyWelcome = sessionStorage.getItem(LEGACY_WELCOME_KEY);
      if (legacyWelcome) sessionStorage.setItem(WELCOME_KEY, legacyWelcome);
    }
  } catch (err) { /* ignore session migration errors */ }

  // ---------------- State ----------------
  const initial = {
    students: [],         // { id, studentName, score, awardCount, lastAwardedAt, history, createdAt, updatedAt }
    searchQuery: '',
    sortOption: 'nameAsc',
    welcomeDialog: false,
    addScoreDialog: { open: false, studentId: null },
    historyDialog: { open: false, studentId: null, picker: false },
    memberDialog: { open: false, tab: 'active' },
    deleteDialog: { open: false, studentId: null },
    docsDialog: false,
    // Active + archive content (replaces the legacy `challenge` slot).
    // Each active row is a server-shaped object with
    // {id, kind, title, text, body, createdAt, expiresAt,
    //  doneCount, totalStudents, viewedBy, setBy, setAt}.
    content: { loading: false, saving: false, error: null,
               active: [],  // newest first
               archive: { open: false, loading: false, items: [] } },
    // FAB popup + the three post-content dialogs.
    fab: { popupOpen: false,
           newChallenge:    { open: false, text: '', expiresAt: '', saving: false, error: null },
           dailyChallenge:  { open: false, text: '', saving: false, error: null },
           notification:    { open: false, title: '', body: '', saving: false, error: null },
           message:         { open: false, title: '', body: '', saving: false, error: null } },
    // Replies: grouped by student username. The server returns
    // {byStudent: {user: [reply, ...]}} on the no-arg GET /api/replies.
    replies: { loading: false, error: null, byStudent: {} },
    // Per-student "last seen" timestamps. The Replies icon shows a
    // badge with the count of replies newer than the last time the
    // teacher opened that student's replies dialog. Once the dialog
    // is opened (and even after closing), the badge clears — the
    // teacher is now caught up. New replies arriving later will
    // re-increment the badge above the recorded timestamp.
    repliesSeenAt: {},
    repliesDialog: { open: false, student: null, items: [], view: 'today' /* or 'archive' */ },
    snackbar: null,       // { id, message }
  };
  let state = loadState();

  // ---------------- Persistence ----------------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...initial, students: [] };
      const parsed = JSON.parse(raw);
      const students = Array.isArray(parsed.students) ? parsed.students : [];
      // Backfill: ensure every student has a history array
      students.forEach(s => { if (!Array.isArray(s.history)) s.history = []; });
      // `repliesSeenAt` is a map of student username -> ms timestamp
      // recording when the teacher last opened that student's
      // replies dialog. We persist it so the badge doesn't reset
      // to "all unread" every time the page is reloaded. Without
      // this, a single page refresh would re-show every past
      // reply as if it were brand new.
      const seen = (parsed.repliesSeenAt && typeof parsed.repliesSeenAt === 'object')
        ? parsed.repliesSeenAt : {};
      return {
        ...initial,
        students,
        repliesSeenAt: seen,
      };
    } catch (err) {
      console.warn('Failed to load state, starting fresh.', err);
      return { ...initial, students: [] };
    }
  }

  // ---------------- Teacher password cache ----------------
  // The teacher password is needed for the server-side teacher-only
  // endpoints (PUT /api/challenge, PUT /api/students/<u>/points, POST
  // /api/delete-student). We don't ask the teacher to type it again
  // from this page — instead, the Login page stashes it in
  // sessionStorage on a successful teacher sign-in, and we read it
  // back here. sessionStorage is per-tab, so the same tab that just
  // signed in carries the password across to this page when the
  // Login page does `window.location.href = "../Teacher's/..."`.
  //
  // If the password isn't there (e.g. someone bookmarked this page
  // and opened it directly), the server PUT will fail with 401 and
  // we silently fall back to the local cache. The next sign-in via
  // the Login page will repopulate sessionStorage.
  function getTeacherPassword() {
    try {
      const pwd = sessionStorage.getItem('teacher.pwd');
      if (pwd) return Promise.resolve(pwd);
    } catch (err) { /* ignore */ }
    return Promise.resolve('');
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        students: state.students,
        // Persist the "last seen" timestamps too — without this,
        // a single page reload would re-show every past reply as
        // if it were brand new (the badge counts replies whose
        // createdAt > seenAt).
        repliesSeenAt: state.repliesSeenAt || {},
      }));
    } catch (err) {
      console.warn('Failed to persist state.', err);
    }
  }

  // ---------------- Reactive subscriptions ----------------
  const subscribers = new Set();
  function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  function notify() { subscribers.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }

  function update(mutator) {
    mutator(state);
    persist();
    notify();
  }

  // ---------------- Selectors (derived data) ----------------
  function filteredAndSorted() {
    const q = state.searchQuery.trim().toLowerCase();
    let list = state.students;
    if (q) list = list.filter(s => s.studentName.toLowerCase().includes(q));
    const cmp = {
      nameAsc:   (a, b) => a.studentName.localeCompare(b.studentName, undefined, { sensitivity: 'base' }),
      scoreDesc: (a, b) => b.score - a.score || a.studentName.localeCompare(b.studentName),
      scoreAsc:  (a, b) => a.score - b.score || a.studentName.localeCompare(b.studentName),
    }[state.sortOption] || ((a, b) => 0);
    return [...list].sort(cmp);
  }

  function classify(list) {
    const now = Date.now();
    const WINDOW = 24 * 60 * 60 * 1000;
    const isActive = s => s.score > 0
      && typeof s.lastAwardedAt === 'number'
      && (now - s.lastAwardedAt) < WINDOW;
    const active = list.filter(isActive);
    const ghost  = list.filter(s => !isActive(s));
    // Within each bucket: sort by score desc, then by award count desc, then by name
    const byEngagement = (a, b) =>
      (b.score - a.score) ||
      (b.awardCount - a.awardCount) ||
      a.studentName.localeCompare(b.studentName, undefined, { sensitivity: 'base' });
    return { active: [...active].sort(byEngagement), ghost: [...ghost].sort(byEngagement) };
  }

  // ---------------- Actions ----------------
  const actions = {
    setSearch(q)              { update(s => { s.searchQuery = q; }); },
    setSort(opt)              { update(s => { s.sortOption = opt; }); },

    openAddScore(id)          { update(s => { s.addScoreDialog = { open: true, studentId: id }; }); },
    closeAddScore()           { update(s => { s.addScoreDialog = { open: false, studentId: null }; }); },

    openHistory(id)           { update(s => { s.historyDialog = { open: true, studentId: id, picker: false }; }); },
    openHistoryPicker()       {
      // If there's only one student, jump straight to their history.
      // If there are zero, show a snackbar. Otherwise show a picker list.
      if (state.students.length === 0) {
        update(s => { s.snackbar = { id: Date.now(), message: 'No students yet' }; });
        return;
      }
      if (state.students.length === 1) {
        const only = state.students[0].id;
        update(s => { s.historyDialog = { open: true, studentId: only, picker: false }; });
        return;
      }
      update(s => { s.historyDialog = { open: true, studentId: null, picker: true }; });
    },
    pickHistoryStudent(id)    { update(s => { s.historyDialog = { ...s.historyDialog, studentId: id, picker: false }; }); },
    closeHistory()            { update(s => { s.historyDialog = { open: false, studentId: null, picker: false }; }); },
    awardDelta(id, delta)     {
      const d = Number(delta);
      if (!Number.isFinite(d) || d <= 0) return false;
      let ok = false;
      let snapshot = null;  // { score, awardCount, lastAwardedAt, history, studentName } for the server PUT
      update(s => {
        const stu = s.students.find(x => x.id === id);
        if (!stu) return;
        const now = Date.now();
        stu.score = Math.max(0, (stu.score || 0) + d);
        stu.awardCount = (stu.awardCount || 0) + 1;
        stu.lastAwardedAt = now;
        stu.updatedAt = now;
        if (!Array.isArray(stu.history)) stu.history = [];
        stu.history.push({ at: now, delta: d });
        s.snackbar = { id: now, message: `Awarded ${d > 0 ? '+' : ''}${d} pts to ${stu.studentName}` };
        s.addScoreDialog = { open: false, studentId: null };
        ok = true;
        // Capture a snapshot AFTER the local write so the server mirror is
        // exactly what the teacher sees on screen.
        snapshot = {
          studentName: stu.studentName,
          score: stu.score,
          awardCount: stu.awardCount,
          lastAwardedAt: stu.lastAwardedAt,
          history: stu.history.slice(),
        };
      });
      // Mirror the write to the server. localStorage is still the cache
      // for offline / instant-read; the server is the source of truth so
      // the Student page can read the same number on any device.
      if (snapshot) {
        getTeacherPassword().then(teacherPassword => {
          if (!teacherPassword) return; // teacher cancelled the prompt
          fetch(API_BASE + '/api/students/' + encodeURIComponent(snapshot.studentName) + '/points', {
            method: 'PUT',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              score: snapshot.score,
              awardCount: snapshot.awardCount,
              lastAwardedAt: snapshot.lastAwardedAt,
              history: snapshot.history,
              teacherPassword,
            }),
          })
            .then(res => {
              if (!res.ok) {
                console.warn('points PUT failed: HTTP ' + res.status);
                // 401 specifically: the tab wasn't signed in via the
                // Login page, so the teacher password isn't in this
                // tab's sessionStorage. Don't alarm the user; just
                // note that the local cache is the source of truth
                // for this session.
                if (res.status === 401) return;
                update(s => {
                  s.snackbar = { id: Date.now(), message: "Saved locally; server didn't pick it up" };
                });
              }
            })
            .catch(err => {
              console.warn('points PUT failed:', err);
              update(s => {
                s.snackbar = { id: Date.now(), message: "Saved locally; server didn't pick it up" };
              });
            });
        });
      }
      return ok;
    },

    renameStudent(id, name)   {
      // Kept as a no-op so any future wiring doesn't break, but no longer
      // triggered. Students rename themselves from the Student page; the
      // gradebook here treats names as read-only labels.
      return false;
    },

    openMemberDialog(tab = 'active') {
      // The 30-second poll re-fetches the gradebook, but if the user
      // clicks the button just after a points award landed on the
      // server, the dialog can render with stale "0 pts · GHOST" data.
      // Force a fresh fetch from the server BEFORE flipping the
      // dialog open so the dialog renders from up-to-date numbers.
      update(s => { s.memberDialog = { open: true, tab }; });
      return actions.refreshStudents();
    },
    closeMemberDialog()       { update(s => { s.memberDialog = { open: false, tab: 'active' }; }); },
    setMemberTab(tab)         { update(s => { s.memberDialog = { ...s.memberDialog, tab }; }); },

    openDocs()                { update(s => { s.docsDialog = true; }); },
    closeDocs()               { update(s => { s.docsDialog = false; }); },

    openWelcome()             { update(s => { s.welcomeDialog = true; }); },
    closeWelcome()            {
      // Mark the welcome as seen for this tab session only. We use sessionStorage
      // (cleared when the tab/window closes) so that the next time the user launches
      // Start Website.bat and a fresh tab opens, the welcome shows again.
      try { sessionStorage.setItem(WELCOME_KEY, '1'); } catch (err) { /* ignore */ }
      update(s => { s.welcomeDialog = false; });
    },

    openDelete(id)            { update(s => { s.deleteDialog = { open: true, studentId: id }; }); },
    closeDelete()             { update(s => { s.deleteDialog = { open: false, studentId: null }; }); },
    confirmDelete()           {
      const stu = state.students.find(x => x.id === state.deleteDialog.studentId);
      if (!stu) {
        update(s => { s.deleteDialog = { open: false, studentId: null }; });
        return;
      }
      const pwd = window.prompt(`Teacher password to confirm deletion of ${stu.studentName}`);
      if (pwd === null) {
        update(s => {
          s.deleteDialog = { open: false, studentId: null };
          s.snackbar = { id: Date.now(), message: 'Delete cancelled' };
        });
        return;
      }
      actions.deleteStudentRemote(stu.studentName, pwd).then(result => {
        if (!result.ok) {
          const msg = result.error || (result.status === 401
            ? 'Wrong teacher password.'
            : result.status === 404
              ? 'That student account no longer exists.'
              : result.status === 0
                ? "Couldn't reach the server."
                : `Delete failed (HTTP ${result.status}).`);
          update(s => {
            s.deleteDialog = { open: false, studentId: null };
            s.snackbar = { id: Date.now(), message: msg };
          });
          return;
        }
        update(s => {
          const name = stu.studentName;
          s.students = s.students.filter(x => x.id !== stu.id);
          s.deleteDialog = { open: false, studentId: null };
          s.snackbar = { id: Date.now(), message: `Deleted ${name}` };
        });
      });
    },

    // Pull the current gradebook from the Python backend. The server is
    // the source of truth for *who exists* AND *what each student has
    // earned*. Using the server's scores directly fixes the "Student
    // page says 20, Teacher page says 0" mismatch: previously we kept
    // whatever was in this tab's localStorage, which lagged behind
    // whenever a teacher awarded points on a different machine or a
    // different tab.
    refreshStudents()         {
      return fetch(API_BASE + '/api/gradebook', { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const serverRows = Array.isArray(data && data.students) ? data.students : [];
          update(s => {
            const next = [];
            const now = Date.now();
            serverRows.forEach(row => {
              const username = String(row.username || '').trim();
              if (!username) return;
              const serverId = String(row.id || '');
              if (!serverId) return;
              next.push({
                id: serverId,
                studentName: username,
                score:         Number(row.score)         || 0,
                awardCount:    Number(row.awardCount)    || 0,
                lastAwardedAt: row.lastAwardedAt || null,
                history:       Array.isArray(row.history) ? row.history : [],
                createdAt:     row.createdAt || null,
                updatedAt:     now,
              });
            });
            s.students = next;
            // No snackbar on refresh — the gradebook visibly updates
            // and the user doesn't need an extra toast saying so.
          });
        })
        .catch(err => {
          console.warn('refreshStudents failed:', err);
          update(s => {
            s.snackbar = { id: Date.now(), message: 'Could not reach server — showing local list' };
          });
        });
    },

    // ---------------- Content (challenges + notifications + archive) ----------------
    // The teacher's content is sourced from /api/content?role=teacher
    // (role=teacher so a teacher preview doesn't add a view to the
    // notification's viewedBy set). The Student page reads the same
    // endpoint with ?username=X to record views.
    loadContent() {
      update(s => { s.content.loading = true; s.content.error = null; });
      return fetch(API_BASE + '/api/content?role=teacher', { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const activeRaw = Array.isArray(data && data.active) ? data.active : [];
          const active = activeRaw.filter(row => !row || !row.archived);
          const archive = Array.isArray(data && data.archive) ? data.archive : [];
          update(s => {
            s.content.active = active;
            // Don't blow away the open/closed state of the drawer if
            // the user is currently looking at it — we only refresh
            // the items, not the visibility flag.
            s.content.archive.items = archive;
            s.content.loading = false;
            s.content.error = null;
          });
        })
        .catch(err => {
          console.warn('loadContent failed:', err);
          update(s => {
            s.content.loading = false;
            s.content.error = "Couldn't reach the server for content";
            s.snackbar = { id: Date.now(), message: "Couldn't reach the server for content" };
          });
        });
    },

    // ---------------- FAB popup ----------------
    openFab()  { update(s => { s.fab.popupOpen = true; }); },
    closeFab() { update(s => { s.fab.popupOpen = false; }); },
    toggleFab() { update(s => { s.fab.popupOpen = !s.fab.popupOpen; }); },

    // ---------------- Post-content dialogs ----------------
    // All three dialogs follow the same pattern: open, validate on
    // save, POST /api/content with kind-specific body. After a
    // successful post, close the dialog and reload content.
    openNewChallenge() {
      update(s => {
        s.fab.popupOpen = false;
        s.fab.newChallenge = { open: true, text: '', expiresAt: '', saving: false, error: null };
      });
      // Prefill a sensible default expiry: 24h from now, rounded to
      // the nearest 5 minutes, formatted for <input type="datetime-local">.
      const now = new Date();
      now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
      now.setHours(now.getHours() + 24);
      const def = formatLocalDateTimeLocal(now);
      const expEl = $('#newChallengeExpires');
      const txtEl = $('#newChallengeInput');
      const errEl = $('#newChallengeError');
      if (expEl) expEl.value = def;
      if (txtEl) txtEl.value = '';
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    },
    closeNewChallenge() {
      update(s => { s.fab.newChallenge = { open: false, text: '', expiresAt: '', saving: false, error: null }; });
    },
    saveNewChallenge(text, expiresAtLocal, returnType) {
      const t = String(text || '').trim();
      const expLocal = String(expiresAtLocal || '').trim();
      if (!t) {
        renderContentError('newChallengeError', 'Type a challenge first.');
        update(s => { s.fab.newChallenge.error = 'Type a challenge first.'; });
        return Promise.resolve();
      }
      if (!expLocal) {
        renderContentError('newChallengeError', 'Pick an expiry date and time.');
        update(s => { s.fab.newChallenge.error = 'Pick an expiry date and time.'; });
        return Promise.resolve();
      }
      const expMs = parseLocalDateTimeLocal(expLocal);
      if (!expMs || expMs <= Date.now() + 60 * 1000) {
        renderContentError('newChallengeError', 'Expiry must be at least a minute in the future.');
        update(s => { s.fab.newChallenge.error = 'Expiry must be at least a minute in the future.'; });
        return Promise.resolve();
      }
      // Return type is optional. The dialog defaults to "text" (the
      // legacy "mark done" flow with a reflection), but the user can
      // pick image/video/audio. Validate against the allowed set
      // client-side so the request doesn't fire with a bad value.
      const allowedRt = ['', 'text', 'image', 'video', 'audio'];
      const rt = allowedRt.indexOf(String(returnType || '')) >= 0 ? String(returnType || '') : '';
      update(s => { s.fab.newChallenge.saving = true; s.fab.newChallenge.error = null; });
      renderContentError('newChallengeError', null);
      return getTeacherPassword().then(teacherPassword => {
        if (!teacherPassword) {
          update(s => { s.fab.newChallenge.saving = false; });
          return;
        }
        return fetch(API_BASE + '/api/content', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'new-challenge',
            text: t,
            expiresAt: expMs,
            returnType: rt || null,
            teacherPassword,
          }),
        });
      })
        .then(res => res ? res.json().then(j => ({ ok: res.ok, j, status: res.status })) : { ok: false, j: null, status: 0 })
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 429
              ? 'Slow down a moment — try again in a few seconds.'
              : (j && j.error) || 'Could not post challenge';
            renderContentError('newChallengeError', msg);
            update(s => { s.fab.newChallenge.saving = false; s.fab.newChallenge.error = msg; });
            return;
          }
          update(s => {
            s.fab.newChallenge = { open: false, text: '', expiresAt: '', saving: false, error: null };
            s.snackbar = { id: Date.now(), message: 'New challenge is live.' };
          });
          actions.loadContent();
        })
        .catch(err => {
          console.warn('saveNewChallenge failed:', err);
          renderContentError('newChallengeError', "Couldn't reach the server.");
          update(s => { s.fab.newChallenge.saving = false; s.fab.newChallenge.error = "Couldn't reach the server."; });
        });
    },

    openDailyChallenge() {
      const alreadyLive = Array.isArray(state.content && state.content.active) && state.content.active.some(item => item && item.kind === 'daily-challenge' && !item.archived);
      if (alreadyLive) {
        update(s => { s.snackbar = { id: Date.now(), message: 'Archive the current Daily Challenge before setting another one.' }; });
        return;
      }
      update(s => {
        s.fab.popupOpen = false;
        s.fab.dailyChallenge = { open: true, text: '', saving: false, error: null };
      });
      const txtEl = $('#dailyChallengeInput');
      const errEl = $('#dailyChallengeError');
      if (txtEl) txtEl.value = '';
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    },
    closeDailyChallenge() {
      update(s => { s.fab.dailyChallenge = { open: false, text: '', saving: false, error: null }; });
    },
    saveDailyChallenge(text, returnType) {
      const t = String(text || '').trim();
      if (!t) {
        renderContentError('dailyChallengeError', 'Type a challenge first.');
        update(s => { s.fab.dailyChallenge.error = 'Type a challenge first.'; });
        return Promise.resolve();
      }
      const allowedRt = ['', 'text', 'image', 'video', 'audio'];
      const rt = allowedRt.indexOf(String(returnType || '')) >= 0 ? String(returnType || '') : '';
      update(s => { s.fab.dailyChallenge.saving = true; s.fab.dailyChallenge.error = null; });
      renderContentError('dailyChallengeError', null);
      return getTeacherPassword().then(teacherPassword => {
        if (!teacherPassword) {
          update(s => { s.fab.dailyChallenge.saving = false; });
          return;
        }
        return fetch(API_BASE + '/api/content', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'daily-challenge',
            text: t,
            returnType: rt || null,
            teacherPassword,
          }),
        });
      })
        .then(res => res ? res.json().then(j => ({ ok: res.ok, j, status: res.status })) : { ok: false, j: null, status: 0 })
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 429
              ? 'Slow down a moment — try again in a few seconds.'
              : (j && j.error) || 'Could not post challenge';
            renderContentError('dailyChallengeError', msg);
            update(s => { s.fab.dailyChallenge.saving = false; s.fab.dailyChallenge.error = msg; });
            return;
          }
          update(s => {
            s.fab.dailyChallenge = { open: false, text: '', saving: false, error: null };
            s.snackbar = { id: Date.now(), message: "Today's challenge is live." };
          });
          actions.loadContent();
        })
        .catch(err => {
          console.warn('saveDailyChallenge failed:', err);
          renderContentError('dailyChallengeError', "Couldn't reach the server.");
          update(s => { s.fab.dailyChallenge.saving = false; s.fab.dailyChallenge.error = "Couldn't reach the server."; });
        });
    },

    openNotification() {
      update(s => {
        s.fab.popupOpen = false;
        s.fab.notification = { open: true, title: '', body: '', saving: false, error: null };
      });
      const tEl = $('#notificationTitleInput');
      const bEl = $('#notificationBodyInput');
      const eEl = $('#notificationError');
      if (tEl) tEl.value = '';
      if (bEl) bEl.value = '';
      if (eEl) { eEl.hidden = true; eEl.textContent = ''; }
    },
    closeNotification() {
      update(s => { s.fab.notification = { open: false, title: '', body: '', saving: false, error: null }; });
    },
    saveNotification(title, body) {
      const t = String(title || '').trim();
      const b = String(body  || '').trim();
      if (!t) {
        renderContentError('notificationError', 'Add a title.');
        update(s => { s.fab.notification.error = 'Add a title.'; });
        return Promise.resolve();
      }
      if (!b) {
        renderContentError('notificationError', 'Write a message.');
        update(s => { s.fab.notification.error = 'Write a message.'; });
        return Promise.resolve();
      }
      update(s => { s.fab.notification.saving = true; s.fab.notification.error = null; });
      renderContentError('notificationError', null);
      return getTeacherPassword().then(teacherPassword => {
        if (!teacherPassword) {
          update(s => { s.fab.notification.saving = false; });
          return;
        }
        return fetch(API_BASE + '/api/content', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'notification', title: t, body: b, teacherPassword }),
        });
      })
        .then(res => res ? res.json().then(j => ({ ok: res.ok, j, status: res.status })) : { ok: false, j: null, status: 0 })
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 429
              ? 'Slow down a moment — try again in a few seconds.'
              : (j && j.error) || 'Could not send notification';
            renderContentError('notificationError', msg);
            update(s => { s.fab.notification.saving = false; s.fab.notification.error = msg; });
            return;
          }
          update(s => {
            s.fab.notification = { open: false, title: '', body: '', saving: false, error: null };
            s.snackbar = { id: Date.now(), message: 'Notification sent.' };
          });
          actions.loadContent();
        })
        .catch(err => {
          console.warn('saveNotification failed:', err);
          renderContentError('notificationError', "Couldn't reach the server.");
          update(s => { s.fab.notification.saving = false; s.fab.notification.error = "Couldn't reach the server."; });
        });
    },

    // ---------------- Message (text + audio replies) dialog ----------------
    openMessage() {
      update(s => {
        s.fab.popupOpen = false;
        s.fab.message = { open: true, title: '', body: '', saving: false, error: null };
      });
      const tEl = $('#messageTitleInput');
      const bEl = $('#messageBodyInput');
      const eEl = $('#messageError');
      if (tEl) tEl.value = '';
      if (bEl) bEl.value = '';
      if (eEl) { eEl.hidden = true; eEl.textContent = ''; }
    },
    closeMessage() {
      update(s => { s.fab.message = { open: false, title: '', body: '', saving: false, error: null }; });
    },
    saveMessage(title, body) {
      const t = String(title || '').trim();
      const b = String(body  || '').trim();
      if (!t) {
        renderContentError('messageError', 'Add a title.');
        update(s => { s.fab.message.error = 'Add a title.'; });
        return Promise.resolve();
      }
      if (!b) {
        renderContentError('messageError', 'Write a message.');
        update(s => { s.fab.message.error = 'Write a message.'; });
        return Promise.resolve();
      }
      update(s => { s.fab.message.saving = true; s.fab.message.error = null; });
      renderContentError('messageError', null);
      return getTeacherPassword().then(teacherPassword => {
        if (!teacherPassword) {
          update(s => { s.fab.message.saving = false; });
          return;
        }
        return fetch(API_BASE + '/api/content', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'message', title: t, body: b, teacherPassword }),
        });
      })
        .then(res => res ? res.json().then(j => ({ ok: res.ok, j, status: res.status })) : { ok: false, j: null, status: 0 })
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 429
              ? 'Slow down a moment — try again in a few seconds.'
              : (j && j.error) || 'Could not send message';
            renderContentError('messageError', msg);
            update(s => { s.fab.message.saving = false; s.fab.message.error = msg; });
            return;
          }
          update(s => {
            s.fab.message = { open: false, title: '', body: '', saving: false, error: null };
            s.snackbar = { id: Date.now(), message: 'Message sent.' };
          });
          actions.loadContent();
        })
        .catch(err => {
          console.warn('saveMessage failed:', err);
          renderContentError('messageError', "Couldn't reach the server.");
          update(s => { s.fab.message.saving = false; s.fab.message.error = "Couldn't reach the server."; });
        });
    },

    // ---------------- Replies ----------------
    // Pull every reply grouped by student. The Teacher's Replies
    // section renders one button per student; the popup for that
    // student pulls the same data and shows the full list with media.
    loadReplies() {
      update(s => { s.replies.loading = true; s.replies.error = null; });
      return fetch(API_BASE + '/api/replies', { cache: 'no-store' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const by = (data && data.byStudent && typeof data.byStudent === 'object')
            ? data.byStudent
            : {};
          update(s => {
            s.replies.byStudent = by;
            s.replies.loading = false;
            s.replies.error = null;
          });
        })
        .catch(err => {
          console.warn('loadReplies failed:', err);
          update(s => {
            s.replies.loading = false;
            s.replies.error = "Couldn't load replies.";
          });
        });
    },
    openRepliesDialog(username) {
      const u = String(username || '').trim();
      if (!u) return;
      const list = (state.replies.byStudent && state.replies.byStudent[u]) || [];
      const openedReplyIds = list.map(r => r && r.id).filter(Boolean);
      update(s => { s.repliesDialog = { open: true, student: u, items: list, view: 'today', openedReplyIds }; });
      if (!state.replies.byStudent || Object.keys(state.replies.byStudent).length === 0) return actions.loadReplies();
    },
    closeRepliesDialog() {
      const dlg = state.repliesDialog || {};
      const ids = Array.isArray(dlg.openedReplyIds) ? dlg.openedReplyIds : [];
      const student = dlg.student;
      update(s => { s.repliesDialog = { open: false, student: null, items: [], view: 'today', openedReplyIds: [] }; });
      if (!ids.length) return;
      fetch(API_BASE + '/api/replies/archive', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      })
        .then(res => res.json().catch(() => ({})).then(data => ({ res, data })))
        .then(({ res, data }) => {
          if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
          const idSet = new Set(ids);
          update(s => {
            const next = { ...(s.replies.byStudent || {}) };
            if (student && Array.isArray(next[student])) {
              next[student] = next[student].filter(r => !idSet.has(r && r.id));
              if (!next[student].length) delete next[student];
            }
            s.replies.byStudent = next;
          });
        })
        .catch(err => { console.warn('archive replies failed:', err); actions.loadReplies(); });
    },
    openRepliesArchiveDialog(username) {
      const u = String(username || '').trim();
      if (!u) return;
      fetch(API_BASE + '/api/replies/archive', { cache: 'no-store' })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(data => {
          const by = (data && data.byStudent && typeof data.byStudent === 'object') ? data.byStudent : {};
          update(s => { s.repliesDialog = { open: true, student: u, items: Array.isArray(by[u]) ? by[u] : [], view: 'archive', openedReplyIds: [] }; });
        })
        .catch(err => console.warn('load reply archive failed:', err));
    },


    // ---------------- Archive drawer ----------------
    openArchive() {
      update(s => { s.content.archive.open = true; });
      // The list is already populated by the periodic loadContent, but
      // an explicit open is a good moment to refresh — the teacher
      // might have just clicked the button and want the freshest list.
      return actions.loadContent();
    },
    closeArchive() {
      update(s => { s.content.archive.open = false; });
    },

    // Manual archive of a single active row. Server returns the same
    // shape as loadContent so the local state can be patched from the
    // response without a second round-trip.
    archiveItem(id, kind) {
      const cleanId = String(id || '').trim();
      if (!cleanId) return Promise.resolve();
      return getTeacherPassword().then(teacherPassword => {
        if (!teacherPassword) return;
        return fetch(API_BASE + '/api/content/' + encodeURIComponent(cleanId) + '/archive', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teacherPassword }),
        });
      })
        .then(res => res ? res.json().then(j => ({ ok: res.ok, j, status: res.status })) : { ok: false, j: null, status: 0 })
        .then(({ ok, j, status }) => {
          if (!ok) {
            const msg = status === 429
              ? 'Slow down a moment.'
              : (j && j.error) || 'Could not archive that item.';
            update(s => { s.snackbar = { id: Date.now(), message: msg }; });
            return;
          }
          update(s => { s.snackbar = { id: Date.now(), message: 'Archived.' }; });
          actions.loadContent();
        })
        .catch(err => {
          console.warn('archiveItem failed:', err);
          update(s => { s.snackbar = { id: Date.now(), message: "Couldn't reach the server." }; });
        });
    },

    // Hard-delete a server account and preserve the real server error.
    deleteStudentRemote(username, teacherPassword) {
      return fetch(API_BASE + '/api/delete-student', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, teacherPassword }),
      })
        .then(async res => {
          let data = null;
          try { data = await res.json(); } catch (err) {}
          return { ok: res.ok, status: res.status, error: data && data.error ? data.error : '' };
        })
        .catch(err => {
          console.warn('deleteStudentRemote failed:', err);
          return { ok: false, status: 0, error: "Couldn't reach the server." };
        });
    },

    clearSnackbar()           { update(s => { s.snackbar = null; }); },

    copyAll() {
      if (!state.students.length) {
        update(s => { s.snackbar = { id: Date.now(), message: 'No students to copy' }; });
        return;
      }
      // Sort by score desc, then name asc — leaderboard order for sharing
      const ordered = [...state.students].sort(
        (a, b) => (b.score - a.score) || a.studentName.localeCompare(b.studentName, undefined, { sensitivity: 'base' })
      );
      const text = buildCopyText(ordered);
      const n = state.students.length;
      const successMsg = `Copied ${n} student${n === 1 ? '' : 's'} to clipboard`;
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          update(s => { s.snackbar = { id: Date.now(), message: ok ? successMsg : 'Copy failed' }; });
        } catch (err) {
          update(s => { s.snackbar = { id: Date.now(), message: 'Copy failed' }; });
        }
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          () => update(s => { s.snackbar = { id: Date.now(), message: successMsg }; }),
          fallback
        );
      } else {
        fallback();
      }
    },
  };

  // ---------------- DOM refs ----------------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ---------------- Helpers ----------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  // The server stores reply media at /media/<file> on the API host
  // (port 3000). The Teacher page is served from a different port, so
  // a server-relative URL like "/media/x.webm" would 404. Always
  // route media through the API origin.
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
  function fmtScore(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
  }
  function buildCopyText(list) {
    if (!list.length) return '';
    const nameCol = 'Name';
    const scoreCol = 'Score';
    const maxName = Math.max(nameCol.length, ...list.map(s => s.studentName.length));
    const width = maxName + 2; // 2-space gap between columns
    const lines = [];
    lines.push(nameCol.padEnd(width, ' ') + scoreCol);
    list.forEach(s => {
      lines.push(s.studentName.padEnd(width, ' ') + fmtScore(s.score));
    });
    return lines.join('\n');
  }
  function fmtTimeAgo(ts) {
    if (!ts) return '—';
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
  function fmtAwardDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function showSnackbar(message) {
    const el = $('#snackbar');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showSnackbar._t);
    showSnackbar._t = setTimeout(() => {
      el.hidden = true;
      actions.clearSnackbar();
    }, 2400);
  }

  // ---------------- datetime-local helpers ----------------
  // <input type="datetime-local"> wants a string in the form
  // "YYYY-MM-DDTHH:MM" (no seconds, no timezone). We format a Date
  // into that and parse one back into a ms timestamp using the
  // *local* clock — which is what a teacher in a classroom expects
  // when they pick a date+time on a wall clock.
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function formatLocalDateTimeLocal(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function parseLocalDateTimeLocal(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), 0, 0
    );
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  function renderContentError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
  }

  // ---------------- Renderers ----------------
  function render() {
    renderBrand();
    $('#copyAllBtn').disabled = state.students.length === 0;
    renderStats();
    renderContent();
    renderReplies();
    renderGradebook();
    renderDialogs();
    if (state.snackbar) showSnackbar(state.snackbar.message);
  }

  function renderBrand() {
    const count = state.students.length;
    $('#brandSub').textContent = `${count} student${count === 1 ? '' : 's'} enrolled`;
  }

  function renderStats() {
    const list = state.students;
    const { active, ghost } = classify(list);
    $('#statTotal').textContent = list.length;
    $('#statActive').textContent = active.length;
    $('#statGhost').textContent  = ghost.length;
  }

  function renderContent() {
    // Renders the "Active content" section: a vertical list of rows
    // for each item in state.content.active. Each row has a small
    // "Archive" action that calls actions.archiveItem(id, kind).
    const active  = (state.content && Array.isArray(state.content.active)) ? state.content.active : [];
    const emptyEl = $('#contentEmpty');
    const listEl  = $('#contentList');
    if (!emptyEl || !listEl) return;

    if (!active.length) {
      emptyEl.hidden = false;
      listEl.hidden = true;
      listEl.innerHTML = '';
      return;
    }
    emptyEl.hidden = true;
    listEl.hidden = false;
    listEl.innerHTML = active.map(rowHtml).join('');

    // Update the lede line with a quick "X active" count.
    const ledeEl = $('#contentLede');
    if (ledeEl) {
      ledeEl.textContent = active.length === 1
        ? '1 item live for your students right now.'
        : `${active.length} items live for your students right now.`;
    }
  }

  function rowHtml(row) {
    const id   = String(row && row.id   || '');
    const kind = String(row && row.kind || '');
    if (kind === 'notification') return notificationRowHtml(row, id);
    if (kind === 'message')      return messageRowHtml(row, id);
    return challengeRowHtml(row, id);
  }

  function challengeRowHtml(row, id) {
    const text = escapeHtml(String((row && row.text) || ''));
    const kindLabel = row.kind === 'new-challenge' ? 'NEW CHALLENGE' : "TODAY'S CHALLENGE";
    const total = Number(row.totalStudents) || 0;
    const done  = Number(row.doneCount)     || 0;
    const exp   = row.expiresAt ? new Date(row.expiresAt) : null;
    const expStr = exp ? `expires ${escapeHtml(exp.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : '';
    const counter = total
      ? `${done} of ${total} student${total === 1 ? '' : 's'} done`
      : 'no students yet';
    return `
      <article class="content-row content-row--challenge" data-id="${escapeHtml(id)}" data-kind="challenge">
        <div class="content-row-head">
          <span class="content-row-eyebrow">${escapeHtml(kindLabel)}</span>
          <span class="content-row-meta">${escapeHtml(counter)}</span>
        </div>
        <p class="content-row-text">${text}</p>
        <div class="content-row-foot">
          <span class="content-row-sub">${expStr}</span>
          <button class="btn btn-ghost btn-archive" type="button" data-content-action="archive" data-id="${escapeHtml(id)}" data-kind="challenge">Archive</button>
        </div>
      </article>
    `;
  }

  function notificationRowHtml(row, id) {
    const title = escapeHtml(String((row && row.title) || 'Notification'));
    const body  = escapeHtml(String((row && row.body)  || ''));
    const viewed = Array.isArray(row.viewedBy) ? row.viewedBy.length : 0;
    const total  = Number(row.totalStudents) || 0;
    const counter = total
      ? `${viewed} of ${total} student${total === 1 ? '' : 's'} have seen this`
      : 'no students enrolled yet';
    return `
      <article class="content-row content-row--notification" data-id="${escapeHtml(id)}" data-kind="notification">
        <div class="content-row-head">
          <span class="content-row-eyebrow">NOTIFICATION</span>
          <span class="content-row-meta">${escapeHtml(counter)}</span>
        </div>
        <p class="content-row-title">${title}</p>
        <p class="content-row-text">${body}</p>
        <div class="content-row-foot">
          <span class="content-row-sub">archives when everyone has seen it</span>
          <button class="btn btn-ghost btn-archive" type="button" data-content-action="archive" data-id="${escapeHtml(id)}" data-kind="notification">Archive</button>
        </div>
      </article>
    `;
  }

  function messageRowHtml(row, id) {
    const title = escapeHtml(String((row && row.title) || 'Message'));
    const body  = escapeHtml(String((row && row.body)  || ''));
    const replies = Number(row.replyCount) || 0;
    const replyPill = replies
      ? `${replies} repl${replies === 1 ? 'y' : 'ies'}`
      : 'no replies yet';
    return `
      <article class="content-row content-row--message" data-id="${escapeHtml(id)}" data-kind="message">
        <div class="content-row-head">
          <span class="content-row-eyebrow">MESSAGE</span>
          <span class="content-row-meta">${escapeHtml(replyPill)}</span>
        </div>
        <p class="content-row-title">${title}</p>
        <p class="content-row-text">${body}</p>
        <div class="content-row-foot">
          <span class="content-row-sub">students can reply with text and an audio recording</span>
          <button class="btn btn-ghost btn-archive" type="button" data-content-action="archive" data-id="${escapeHtml(id)}" data-kind="message">Archive</button>
        </div>
      </article>
    `;
  }

  // Build a map of parentId -> { kind, title/text, body } so the
  // reply dialog can label each reply with which message/challenge
  // it was a response to. We pull from the active list (notifications
  // and messages) and from a flat view of challenges by id.
  function _repliesParentIndex() {
    const idx = {};
    try {
      const active = (state.content && Array.isArray(state.content.active)) ? state.content.active : [];
      for (const r of active) {
        if (!r || !r.id) continue;
        const k = String(r.kind || '');
        if (k === 'message' || k === 'notification') {
          idx[String(r.id)] = {
            kind: k,
            label: String(r.title || (k === 'message' ? 'Message' : 'Notification')),
            body:  String(r.body || ''),
          };
        } else if (k === 'daily-challenge' || k === 'new-challenge') {
          idx[String(r.id)] = {
            kind: 'challenge',
            label: k === 'daily-challenge' ? "Today's challenge" : 'Challenge',
            body:  String(r.text || ''),
          };
        }
      }
    } catch (err) { /* ignore */ }
    return idx;
  }

  function renderReplies() {
    const emptyEl = $('#repliesEmpty');
    const gridEl  = $('#repliesGrid');
    const ledeEl  = $('#repliesLede');
    if (!emptyEl || !gridEl) return;
    const by = (state.replies && state.replies.byStudent) || {};
    const usernames = Object.keys(by).filter(u => Array.isArray(by[u]) && by[u].length);
    // Sort by most-recent reply (newest first per student, then by latest reply timestamp).
    usernames.sort((a, b) => {
      const aMax = Math.max(0, ...by[a].map(r => Number(r.createdAt) || 0));
      const bMax = Math.max(0, ...by[b].map(r => Number(r.createdAt) || 0));
      return bMax - aMax;
    });

    if (!usernames.length) {
      emptyEl.hidden = false;
      gridEl.hidden = true;
      gridEl.innerHTML = '';
      if (ledeEl) {
        ledeEl.textContent = 'Tap a student to see their replies to your challenges and messages.';
      }
      return;
    }
    emptyEl.hidden = true;
    gridEl.hidden = false;
    if (ledeEl) {
      const total = usernames.reduce((n, u) => n + by[u].length, 0);
      ledeEl.textContent = total === 1
        ? '1 reply from 1 student. Tap to view.'
        : `${total} replies from ${usernames.length} student${usernames.length === 1 ? '' : 's'}. Tap to view.`;
    }
    gridEl.innerHTML = usernames.map(u => {
      const items = by[u];
      const latest = items.slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
      const latestAt = latest ? new Date(Number(latest.createdAt) || 0) : null;
      const latestStr = latestAt
        ? `${escapeHtml(latestAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}`
        : '';
      return `
        <button class="replies-student-btn" type="button" data-replies-student="${escapeHtml(u)}">
          <span class="replies-student-name">${escapeHtml(u)}</span>
          <span class="replies-student-count">${items.length} repl${items.length === 1 ? 'y' : 'ies'}</span>
          <span class="replies-student-latest">${latestStr}</span>
        </button>
      `;
    }).join('');
  }

  function renderRepliesDialog() {
    const dlg = state.repliesDialog;
    if (!dlg || !dlg.open) return;
    const listEl = $('#repliesDialogList');
    const ctxEl  = $('#repliesDialogContext');
    const nameEl = $('#repliesDialogStudent');
    const titleEl = $('#repliesDialogTitle');
    // Update the title prefix based on which view is active.
    // "Replies · <name>" for today-only, "Archive · <name>" for the
    // date-grouped history view. The student name lives in a child
    // <span>; we keep that span and just rewrite the leading text.
    if (nameEl) nameEl.textContent = dlg.student || '';
    if (titleEl) {
      const prefix = dlg.view === 'archive' ? 'Archive' : 'Replies';
      titleEl.firstChild.nodeValue = prefix + ' · ';
    }
    if (!listEl) return;

    // The dialog has two views, switched by the icon that opened it:
    //   'today'   — speech-bubble Replies icon. Shows only replies
    //               from today, each with a per-reply timestamp and
    //               the parent (challenge or message) it replied to.
    //   'archive' — box Archive icon. Shows ALL replies from this
    //               student, grouped by date with NO per-reply
    //               timestamps (just the text / picture / video /
    //               audio reply stacked vertically under each day).
    const view = dlg.view === 'archive' ? 'archive' : 'today';
    const allItems = (dlg.items || []).slice();

    // "Today" means the local day the dialog is rendered on, not a
    // 24-hour rolling window. A reply sent at 11:59 PM is still
    // "today" until the clock rolls past midnight.
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const items = view === 'today'
      ? allItems.filter(r => (Number(r.createdAt) || 0) >= todayStart)
      : allItems;

    if (ctxEl) {
      if (view === 'archive') {
        ctxEl.textContent = items.length
          ? `${items.length} repl${items.length === 1 ? 'y' : 'ies'} from ${dlg.student} so far.`
          : `${dlg.student} hasn't replied yet.`;
      } else {
        ctxEl.textContent = items.length
          ? `${items.length} repl${items.length === 1 ? 'y' : 'ies'} from ${dlg.student} today.`
          : `${dlg.student} hasn't replied today.`;
      }
    }
    if (!items.length) {
      const empty = view === 'archive'
        ? `<div class="replies-empty-text">No replies to show yet.</div>`
        : `<div class="replies-empty-text">No replies today yet.</div>`;
      listEl.innerHTML = empty;
      return;
    }

    const parentIdx = _repliesParentIndex();

    // Helper: render a single reply card. `showMeta` is true in the
    // "today" view (we show the per-reply timestamp and the parent
    // kind/label). In the "archive" view we hide those — the date
    // is already in the section heading and the user asked for no
    // timestamps on individual replies.
    const renderReplyCard = (r, showMeta) => {
      const parent = parentIdx[String(r.parentId)] || { kind: 'unknown', label: 'Removed', body: '' };
      const text   = r.text ? `<p class="replies-detail-text">${escapeHtml(String(r.text))}</p>` : '';
      const url = mediaUrl(r.mediaUrl);
      const mediaType = String(r.mediaType || '');
      let media = '';
      if (url) {
        if (mediaType === 'image' || /\.(jpe?g|png|gif|webp|bmp)$/i.test(url)) {
          media = `<img class="replies-media" src="${escapeHtml(url)}" alt="Reply image" />`;
        } else if (mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(url)) {
          media = `<video class="replies-media" src="${escapeHtml(url)}" controls preload="metadata"></video>`;
        } else if (mediaType === 'audio' || /\.(mp3|wav|ogg|m4a|webm)$/i.test(url)) {
          media = `<audio class="replies-media" src="${escapeHtml(url)}" controls preload="metadata"></audio>`;
        } else {
          media = `<a class="replies-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open attachment</a>`;
        }
      }
      let header = '';
      if (showMeta) {
        const at = r.createdAt ? new Date(Number(r.createdAt) || 0) : null;
        const atStr = at ? escapeHtml(at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : '';
        const parentKind = String(parent.kind || 'unknown');
        const parentLabel = String(parent.label || '—');
        header = `
          <header class="replies-detail-head">
            <span class="replies-detail-kind">${escapeHtml(parentKind)}</span>
            <span class="replies-detail-parent">to: <strong>${escapeHtml(parentLabel)}</strong></span>
            <span class="replies-detail-when">${atStr}</span>
          </header>
        `;
      }
      return `
        <article class="replies-detail-row">
          ${header}
          ${text}
          ${media}
        </article>
      `;
    };

    if (view === 'archive') {
      // Group by local day, newest day first. The day header shows
      // the date in the format the user asked for ("June 20th 2026").
      // No per-reply timestamp — the date is in the heading.
      const groups = new Map(); // key: yyyy-mm-dd, value: [replies, ...]
      for (const r of items) {
        const d = new Date(Number(r.createdAt) || 0);
        if (!Number.isFinite(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const dayKeys = Array.from(groups.keys()).sort().reverse();
      listEl.innerHTML = dayKeys.map(key => {
        const dayItems = groups.get(key).slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
        return `
          <section class="replies-day-group">
            <h3 class="replies-day-heading">${escapeHtml(prettyDayHeading(key))}</h3>
            <div class="replies-day-list">
              ${dayItems.map(r => renderReplyCard(r, false)).join('')}
            </div>
          </section>
        `;
      }).join('');
    } else {
      // Today view: single flat list (all replies are from today),
      // newest first. Each card shows the per-reply timestamp +
      // parent label.
      const sorted = items.slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      listEl.innerHTML = sorted.map(r => renderReplyCard(r, true)).join('');
    }
  }

  // "2026-06-20" -> "June 20th 2026"
  function prettyDayHeading(yyyymmdd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd || '');
    if (!m) return yyyymmdd || '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const month = d.toLocaleDateString(undefined, { month: 'long' });
    const day = Number(m[3]);
    const suffix = (day % 100 >= 11 && day % 100 <= 13)
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
    return `${month} ${day}${suffix} ${m[1]}`;
  }

  function renderArchive() {
    const items = (state.content && state.content.archive && Array.isArray(state.content.archive.items))
      ? state.content.archive.items
      : [];
    const ctx = $('#archiveContext');
    const listEl = $('#archiveList');
    if (!ctx || !listEl) return;

    if (state.content.archive.loading && !items.length) {
      ctx.textContent = 'Loading…';
      listEl.innerHTML = `<div class="drawer-row-empty">Loading…</div>`;
      return;
    }
    if (!items.length) {
      ctx.textContent = 'No archived content yet.';
      listEl.innerHTML = `<div class="drawer-row-empty">Nothing here yet.</div>`;
      return;
    }
    ctx.textContent = `${items.length} archived item${items.length === 1 ? '' : 's'} · newest first.`;

    listEl.innerHTML = items.map(a => {
      const kind = String(a.kind || '');
      const title = escapeHtml(String(a.title || (kind === 'notification' || kind === 'message' ? 'Notification' : 'Challenge')));
      const body  = (kind === 'notification' || kind === 'message')
        ? `<p class="archive-row-body">${escapeHtml(String(a.body || ''))}</p>`
        : `<p class="archive-row-body">${escapeHtml(String(a.text || ''))}</p>`;
      const reason = archiveReasonLabel(a.archiveReason);
      const when = a.archivedAt
        ? `archived ${escapeHtml(fmtTimeAgo(a.archivedAt))}`
        : '';
      return `
        <article class="archive-row archive-row--${escapeHtml(kind)}">
          <div class="archive-row-head">
            <span class="archive-row-eyebrow">${escapeHtml(archiveKindLabel(kind))}</span>
            <span class="archive-row-meta">${escapeHtml(reason)}${when ? ' · ' + when : ''}</span>
          </div>
          <p class="archive-row-title">${title}</p>
          ${body}
        </article>
      `;
    }).join('');
  }

  function archiveKindLabel(kind) {
    if (kind === 'notification')    return 'NOTIFICATION';
    if (kind === 'new-challenge')   return 'NEW CHALLENGE';
    if (kind === 'message')         return 'MESSAGE';
    return "TODAY'S CHALLENGE";
  }
  function archiveReasonLabel(reason) {
    if (reason === 'expired')    return 'expired';
    if (reason === 'all-viewed') return 'everyone viewed';
    if (reason === 'manual')     return 'archived manually';
    if (reason === 'replaced')   return 'replaced';
    return '';
  }

  function renderGradebook() {
    const list = filteredAndSorted();

    const tbody = $('#gradeTableBody');
    const wrap  = $('#tableWrap');
    const cardList = $('#cardList');
    const empty = $('#emptyState');
    const sub = $('#gradebookSub');

    if (!state.students.length) {
      sub.textContent = 'No students yet — add your first one.';
      wrap.hidden = true;
      cardList.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;
    sub.textContent = `${list.length} student${list.length === 1 ? '' : 's'}${state.searchQuery ? ` matching "${state.searchQuery}"` : ''}`;

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No matches for "${escapeHtml(state.searchQuery)}".</td></tr>`;
      cardList.innerHTML = `<div class="empty-state"><p>No matches.</p></div>`;
      return;
    }

    // Table rows
    tbody.innerHTML = list.map((s, i) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? `rank-${rank}` : '';
      return `
        <tr data-id="${s.id}">
          <td><span class="rank-badge ${rankClass}">${rank}</span></td>
          <td>
            <div class="student-cell">
              <div class="avatar" style="background:${avatarColor(s.studentName)}">${escapeHtml(initials(s.studentName))}</div>
              <div>
                <div class="student-name">${escapeHtml(s.studentName)}</div>
                <div class="student-meta">last awarded ${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</div>
              </div>
            </div>
          </td>
          <td><span class="score-pill">${fmtScore(s.score)}</span></td>
          <td>
            <div class="history-cell">
              <button class="btn-icon-history" data-action="history" data-id="${s.id}" title="View award history" aria-label="View award history">
                <svg class="history-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7"></path>
                  <polyline points="3 4 3 9 8 9"></polyline>
                  <circle cx="12" cy="12" r="3.2"></circle>
                  <polyline points="12 9.5 12 12 13.8 13"></polyline>
                </svg>
              </button>
            </div>
          </td>
          <td>
            <div class="replies-cell">
              <button class="btn-icon-replies" data-action="replies" data-id="${escapeHtml(s.studentName)}" title="View today's replies" aria-label="View today's replies">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                ${(() => {
                  const list = (state.replies.byStudent && state.replies.byStudent[s.studentName]) || [];
                  if (!list.length) return '';
                  const seenAt = (state.repliesSeenAt && state.repliesSeenAt[s.studentName]) || 0;
                  // Count only replies that arrived AFTER the last time
                  // the teacher opened this student's replies dialog.
                  // Once opened, the badge drops to 0; new replies
                  // arriving after `seenAt` re-increment the count.
                  const unseen = list.filter(r => (Number(r.createdAt) || 0) > seenAt).length;
                  if (!unseen) return '';
                  return `<span class="replies-badge" aria-label="${unseen} new repl${unseen === 1 ? 'y' : 'ies'}">${unseen > 99 ? '99+' : unseen}</span>`;
                })()}
              </button>
            </div>
          </td>
          <td>
            <div class="action-row">
              <button class="btn-icon" data-action="award" data-id="${s.id}" title="Award points" aria-label="Award points">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button class="btn-icon btn-icon-archive" data-action="replies-archive" data-id="${escapeHtml(s.studentName)}" title="View ${escapeHtml(s.studentName)}'s reply archive" aria-label="View reply archive">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="4" rx="1.5"></rect>
                  <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"></path>
                  <line x1="10" y1="13" x2="14" y2="13"></line>
                </svg>
              </button>
              <button class="btn-icon" data-action="delete" data-id="${s.id}" title="Delete student" aria-label="Delete student">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Mobile cards
    cardList.innerHTML = list.map(s => {
      return `
        <article class="student-card" data-id="${s.id}">
          <div class="student-card-head">
            <div class="avatar" style="background:${avatarColor(s.studentName)}">${escapeHtml(initials(s.studentName))}</div>
            <div style="flex:1;min-width:0">
              <div class="student-name">${escapeHtml(s.studentName)}</div>
              <div class="student-meta">last awarded ${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</div>
            </div>
            <div class="history-cell">
              <button class="btn-icon-history" data-action="history" data-id="${s.id}" title="View award history" aria-label="View award history">
                <svg class="history-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7"></path>
                  <polyline points="3 4 3 9 8 9"></polyline>
                  <circle cx="12" cy="12" r="3.2"></circle>
                  <polyline points="12 9.5 12 12 13.8 13"></polyline>
                </svg>
              </button>
            </div>
          </div>
          <div class="student-card-stats">
            <span class="score-pill">${fmtScore(s.score)} pts</span>
          </div>
          <div class="student-card-actions">
            <button class="btn btn-primary" data-action="award" data-id="${s.id}">+ Award</button>
            <button class="btn btn-ghost"   data-action="replies" data-id="${escapeHtml(s.studentName)}">Replies</button>
            <button class="btn btn-ghost"   data-action="replies-archive" data-id="${escapeHtml(s.studentName)}" title="View ${escapeHtml(s.studentName)}'s reply archive">Archive</button>
            <button class="btn btn-ghost"   data-action="delete" data-id="${s.id}">Delete</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderDialogs() {
    // (Add Student dialog removed — students self-register via the Login page)

    // Add Score
    $('#addScoreDialog').hidden = !state.addScoreDialog.open;
    if (state.addScoreDialog.open) {
      const stu = state.students.find(s => s.id === state.addScoreDialog.studentId);
      if (stu) {
        $('#addScoreName').textContent = stu.studentName;
        $('#addScoreCurrent').textContent = fmtScore(stu.score);
        $('#customDelta').value = '';
      }
    }

    // (Edit Student dialog removed — students rename themselves from the Student page)

    // History
    $('#historyDialog').hidden = !state.historyDialog.open;
    if (state.historyDialog.open) renderHistoryDialog();

    // Member dialog
    $('#memberDialog').hidden = !state.memberDialog.open;
    if (state.memberDialog.open) renderMemberDialog();

    // Replies dialog (per-student popup)
    $('#repliesDialog').hidden = !state.repliesDialog.open;
    if (state.repliesDialog.open) renderRepliesDialog();

    // Delete
    $('#deleteDialog').hidden = !state.deleteDialog.open;
    if (state.deleteDialog.open) {
      const stu = state.students.find(s => s.id === state.deleteDialog.studentId);
      if (stu) $('#deleteName').textContent = stu.studentName;
    }

    // Docs
    $('#docsDialog').hidden = !state.docsDialog;

    // Welcome (first-visit only)
    $('#welcomeDialog').hidden = !state.welcomeDialog;

    // FAB + post-content dialogs
    const fab = state.fab || {};
    $('#fabPopup').hidden = !fab.popupOpen;
    $('#fabBackdrop').hidden = !fab.popupOpen;
    $('#newChallengeDialog').hidden   = !(fab.newChallenge   && fab.newChallenge.open);
    $('#dailyChallengeDialog').hidden = !(fab.dailyChallenge && fab.dailyChallenge.open);
    $('#notificationDialog').hidden   = !(fab.notification   && fab.notification.open);
    $('#messageDialog').hidden        = !(fab.message        && fab.message.open);

    // Save-button states.
    const ncb = $('#newChallengeSaveBtn');
    if (ncb) {
      const saving = !!(fab.newChallenge && fab.newChallenge.saving);
      ncb.disabled = saving;
      ncb.textContent = saving ? 'Posting…' : 'Post';
    }
    const dcb = $('#dailyChallengeSaveBtn');
    if (dcb) {
      const saving = !!(fab.dailyChallenge && fab.dailyChallenge.saving);
      dcb.disabled = saving;
      dcb.textContent = saving ? 'Posting…' : 'Post';
    }
    const nb = $('#notificationSaveBtn');
    if (nb) {
      const saving = !!(fab.notification && fab.notification.saving);
      nb.disabled = saving;
      nb.textContent = saving ? 'Sending…' : 'Send';
    }
    const mb = $('#messageSaveBtn');
    if (mb) {
      const saving = !!(fab.message && fab.message.saving);
      mb.disabled = saving;
      mb.textContent = saving ? 'Sending…' : 'Send';
    }

    // Archive drawer
    const ar = state.content && state.content.archive ? state.content.archive : { open: false, items: [] };
    $('#archiveDrawer').hidden = !ar.open;
    if (ar.open) renderArchive();
  }

  function renderHistoryDialog() {
    const dialog = state.historyDialog;

    // Picker view: shown when the new "History" section is clicked and there
    // are multiple students to choose from.
    if (dialog.picker) {
      $('#historyName').textContent = 'Pick a student';
      $('#historyTotal').textContent = String(state.students.length);
      const sorted = [...state.students].sort(
        (a, b) => a.studentName.localeCompare(b.studentName, undefined, { sensitivity: 'base' })
      );
      $('#historyList').innerHTML = `
        <div class="history-picker">
          ${sorted.map(s => `
            <button class="history-picker-row" data-action="pickHistory" data-id="${s.id}" type="button">
              <div class="avatar" style="background:${avatarColor(s.studentName)}">${escapeHtml(initials(s.studentName))}</div>
              <div class="history-picker-name">${escapeHtml(s.studentName)}</div>
              <span class="score-pill">${fmtScore(s.score)}</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 6 15 12 9 18"></polyline>
              </svg>
            </button>
          `).join('')}
        </div>
      `;
      return;
    }

    const stu = state.students.find(s => s.id === dialog.studentId);
    if (!stu) {
      $('#historyName').textContent = '—';
      $('#historyTotal').textContent = '0';
      $('#historyList').innerHTML = '';
      return;
    }
    $('#historyName').textContent = stu.studentName;
    $('#historyTotal').textContent = fmtScore(stu.score);

    const events = Array.isArray(stu.history) ? stu.history.slice().sort((a, b) => b.at - a.at) : [];
    const list = $('#historyList');

    // Build the "Created on <date>" header row, then the subsequent awards
    // laid out as simple date-on-left / points-on-right rows.
    const createdAt = stu.createdAt || (events.length ? events[events.length - 1].at : null);
    const createdDelta = events.length ? events[events.length - 1].delta : 0;
    // sign(): prepend "+" only for positive numbers so negatives render as "-5",
    // not "+-5" (which was the old behavior).
    const sign = (n) => (n > 0 ? '+' : '');
    const createdRow = createdAt
      ? `
        <li class="history-row history-row-created">
          <span class="history-row-date">Created on ${escapeHtml(fmtAwardDate(createdAt))}</span>
          <span class="history-row-points history-row-points--start">${sign(createdDelta)}${fmtScore(createdDelta)}</span>
        </li>
      `
      : '';

    if (!events.length) {
      list.innerHTML = `<div class="history-empty">No awards yet. Award some points to start a history.</div>`;
      return;
    }

    // Drop the very first event from the chronological "subsequent" list
    // because we just rendered its points on the "Created on" row.
    const subsequent = events.slice(0, -1).reverse(); // newest first, but skip the oldest (creation) entry

    list.innerHTML = `
      <ul class="history-rows">
        ${createdRow}
        ${subsequent.length === 0
          ? `<li class="history-row history-row-empty">No further awards since creation.</li>`
          : subsequent.map(ev => `
              <li class="history-row">
                <span class="history-row-date">${escapeHtml(fmtAwardDate(ev.at))}</span>
                <span class="history-row-points">${sign(ev.delta)}${fmtScore(ev.delta)}</span>
              </li>
            `).join('')
        }
      </ul>
    `;
  }

  function renderMemberDialog() {
    const { active, ghost } = classify(state.students);
    $('#tabActiveCount').textContent = active.length;
    $('#tabGhostCount').textContent  = ghost.length;

    const tab = state.memberDialog.tab;
    $$('.tab').forEach(btn => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    $('#panelActive').hidden = tab !== 'active';
    $('#panelGhost').hidden  = tab !== 'ghost';

    const list = tab === 'active' ? active : ghost;
    const target = tab === 'active' ? '#panelActive' : '#panelGhost';
    const container = $(target);

    if (!list.length) {
      container.innerHTML = `<div class="tab-panel-empty">No ${tab} members yet.</div>`;
      return;
    }

    // Defensive guard: a stale or buggy render could in principle hand us
    // the wrong bucket. The count chip in the tab header is the source of
    // truth for "how many should be in this list" — keep the rendered list
    // length aligned to it.
    const expectedCount = tab === 'active' ? active.length : ghost.length;
    const safeList = list.slice(0, expectedCount);

    // No "+ Award" button in the member classification dialog — awarding
    // is done from the main gradebook rows. The dialog is a read-only view
    // of who's active vs ghost.
    container.innerHTML = safeList.map(s => `
      <div class="tab-panel-row">
        <div>
          <div class="row-name">${escapeHtml(s.studentName)}</div>
          <div class="row-meta">${fmtScore(s.score)} pts</div>
        </div>
        <span class="status-chip ${tab === 'active' ? 'status-active' : 'status-ghost'}">
          <span class="dot"></span>${tab === 'active' ? 'Active' : 'Ghost'}
        </span>
        <span class="award-pill">${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</span>
      </div>
    `).join('');
  }

  // ---------------- Event wiring ----------------
  function wireEvents() {
    // Header
    $('#searchInput').addEventListener('input', e => actions.setSearch(e.target.value));
    $('#sortSelect').addEventListener('change', e => actions.setSort(e.target.value));
    $('#copyAllBtn').addEventListener('click', () => actions.copyAll());
    $('#docsBtn').addEventListener('click', () => actions.openDocs());
    $('#memberStatusBtn').addEventListener('click', () => actions.openMemberDialog('active'));

    // Daily challenge (read-only on the teacher side; teacher posts/edits
    // via the input + Save button, and watches the done counter).
    // (Replaced by the FAB + 3-option popup; the inline editor is gone.)

    // Generic close buttons
    document.addEventListener('click', e => {
      const closeId = e.target.closest('[data-close-dialog]')?.dataset.closeDialog;
      if (closeId) {
        e.preventDefault();
        const dialog = $('#' + closeId);
        if (dialog === $('#addScoreDialog'))         actions.closeAddScore();
        else if (dialog === $('#historyDialog'))     actions.closeHistory();
        else if (dialog === $('#memberDialog'))      actions.closeMemberDialog();
        else if (dialog === $('#repliesDialog'))     actions.closeRepliesDialog();
        else if (dialog === $('#deleteDialog'))      actions.closeDelete();
        else if (dialog === $('#docsDialog'))        actions.closeDocs();
        else if (dialog === $('#welcomeDialog'))     actions.closeWelcome();
        else if (dialog === $('#newChallengeDialog'))   actions.closeNewChallenge();
        else if (dialog === $('#dailyChallengeDialog')) actions.closeDailyChallenge();
        else if (dialog === $('#notificationDialog'))   actions.closeNotification();
        else if (dialog === $('#messageDialog'))        actions.closeMessage();
        else if (dialog === $('#archiveDrawer'))        actions.closeArchive();
      }
    });

    // Backdrop click closes
    $$('.dialog-backdrop').forEach(bd => {
      bd.addEventListener('click', e => {
        if (e.target !== bd) return;
        const id = bd.id;
        if (id === 'addScoreDialog')         actions.closeAddScore();
        else if (id === 'historyDialog')     actions.closeHistory();
        else if (id === 'memberDialog')      actions.closeMemberDialog();
        else if (id === 'repliesDialog')     actions.closeRepliesDialog();
        else if (id === 'deleteDialog')      actions.closeDelete();
        else if (id === 'docsDialog')        actions.closeDocs();
        else if (id === 'welcomeDialog')     actions.closeWelcome();
        else if (id === 'newChallengeDialog')   actions.closeNewChallenge();
        else if (id === 'dailyChallengeDialog') actions.closeDailyChallenge();
        else if (id === 'notificationDialog')   actions.closeNotification();
        else if (id === 'messageDialog')        actions.closeMessage();
      });
    });
    // Archive drawer backdrop click
    const archBd = $('#archiveDrawer');
    if (archBd) {
      archBd.addEventListener('click', e => {
        if (e.target === archBd) actions.closeArchive();
      });
    }

    // Escape closes any open dialog (top-most first)
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.fab.newChallenge.open)                actions.closeNewChallenge();
      else if (state.fab.dailyChallenge.open)         actions.closeDailyChallenge();
      else if (state.fab.notification.open)           actions.closeNotification();
      else if (state.fab.message.open)                actions.closeMessage();
      else if (state.repliesDialog.open)              actions.closeRepliesDialog();
      else if (state.content.archive.open)            actions.closeArchive();
      else if (state.fab.popupOpen)                   actions.closeFab();
      else if (state.welcomeDialog)                   actions.closeWelcome();
      else if (state.docsDialog)                      actions.closeDocs();
      else if (state.addScoreDialog.open)             actions.closeAddScore();
      else if (state.historyDialog.open)              actions.closeHistory();
      else if (state.memberDialog.open)               actions.closeMemberDialog();
      else if (state.deleteDialog.open)               actions.closeDelete();
    });

    // Add Score dialog
    $$('#addScoreDialog .delta-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.delta);
        actions.awardDelta(state.addScoreDialog.studentId, delta);
      });
    });
    $('#customDelta').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = Number($('#customDelta').value);
        if (Number.isFinite(v) && v !== 0) {
          actions.awardDelta(state.addScoreDialog.studentId, v);
          $('#customDelta').value = '';
        }
      }
    });

    // (Edit dialog removed — rename via double-click on student name)

    // Member dialog tabs
    $$('#memberDialog .tab').forEach(tab => {
      tab.addEventListener('click', () => actions.setMemberTab(tab.dataset.tab));
    });

    // Delete
    $('#deleteConfirm').addEventListener('click', () => actions.confirmDelete());

    // Delegated clicks for table/card actions
    document.addEventListener('click', e => {
      const trigger = e.target.closest('[data-action]');
      if (!trigger) return;
      const id = trigger.dataset.id;
      const action = trigger.dataset.action;
      if (action === 'award')             actions.openAddScore(id);
      if (action === 'history')           actions.openHistory(id);
      if (action === 'delete')            actions.openDelete(id);
      if (action === 'replies')           actions.openRepliesDialog(id);
      if (action === 'replies-archive')   actions.openRepliesArchiveDialog(id);
      if (action === 'pickHistory')       actions.pickHistoryStudent(id);
    });

    // ---------------- FAB + post-content + archive ----------------
    const fabBtn = $('#fabBtn');
    if (fabBtn) fabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.toggleFab();
    });
    // Tap the FAB backdrop to close the popup. (document.click
    // below also handles it; the explicit listener makes the
    // touch intent obvious and stops the click from bubbling
    // into the page.)
    const fabBackdrop = $('#fabBackdrop');
    if (fabBackdrop) fabBackdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.fab && state.fab.popupOpen) actions.closeFab();
    });
    // Tap-outside closes the FAB popup (so the rest of the page stays
    // usable while it's open).
    document.addEventListener('click', e => {
      if (!state.fab.popupOpen) return;
      const popup = $('#fabPopup');
      if (!popup) return;
      if (e.target === fabBtn) return;          // handled above
      if (popup.contains(e.target)) return;     // clicking inside is fine
      actions.closeFab();
    });
    // Pick a FAB option.
    document.addEventListener('click', e => {
      const opt = e.target.closest('[data-fab-action]');
      if (!opt) return;
      const which = opt.dataset.fabAction;
      if (which === 'new-challenge')   actions.openNewChallenge();
      else if (which === 'daily-challenge') actions.openDailyChallenge();
      else if (which === 'notification')   actions.openNotification();
      else if (which === 'message')         actions.openMessage();
    });

    // New challenge save
    const ncSave = $('#newChallengeSaveBtn');
    if (ncSave) ncSave.addEventListener('click', () => {
      actions.saveNewChallenge(
        ($('#newChallengeInput')   || {}).value,
        ($('#newChallengeExpires') || {}).value,
        ($('input[name="newChallengeReturnType"]:checked') || {}).value,
      );
    });
    // Enter in the new-challenge textarea (Ctrl/Cmd-Enter since plain
    // Enter would insert a newline).
    const ncInput = $('#newChallengeInput');
    if (ncInput) ncInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.saveNewChallenge(
          ($('#newChallengeInput')   || {}).value,
          ($('#newChallengeExpires') || {}).value,
          ($('input[name="newChallengeReturnType"]:checked') || {}).value,
        );
      }
    });

    // Daily challenge save
    const dcSave = $('#dailyChallengeSaveBtn');
    if (dcSave) dcSave.addEventListener('click', () => {
      actions.saveDailyChallenge(
        ($('#dailyChallengeInput') || {}).value,
        ($('input[name="dailyChallengeReturnType"]:checked') || {}).value,
      );
    });
    const dcInput = $('#dailyChallengeInput');
    if (dcInput) dcInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.saveDailyChallenge(
          ($('#dailyChallengeInput') || {}).value,
          ($('input[name="dailyChallengeReturnType"]:checked') || {}).value,
        );
      }
    });

    // Notification save
    const nSave = $('#notificationSaveBtn');
    if (nSave) nSave.addEventListener('click', () => {
      actions.saveNotification(
        ($('#notificationTitleInput') || {}).value,
        ($('#notificationBodyInput')  || {}).value,
      );
    });
    const nInput = $('#notificationBodyInput');
    if (nInput) nInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.saveNotification(
          ($('#notificationTitleInput') || {}).value,
          ($('#notificationBodyInput')  || {}).value,
        );
      }
    });

    // Message save
    const mSave = $('#messageSaveBtn');
    if (mSave) mSave.addEventListener('click', () => {
      actions.saveMessage(
        ($('#messageTitleInput') || {}).value,
        ($('#messageBodyInput')  || {}).value,
      );
    });
    const mInput = $('#messageBodyInput');
    if (mInput) mInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.saveMessage(
          ($('#messageTitleInput') || {}).value,
          ($('#messageBodyInput')  || {}).value,
        );
      }
    });

    // Open archive from the Active content footer
    const openAr = $('#openArchiveBtn');
    if (openAr) openAr.addEventListener('click', () => actions.openArchive());

    // Delegated handler for the "Archive" button on a content row.
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-content-action]');
      if (!t) return;
      const action = t.dataset.contentAction;
      if (action === 'archive') actions.archiveItem(t.dataset.id, t.dataset.kind);
    });

    // Delegated handler for per-student reply buttons in the Replies
    // section. Tap a student to open the replies popup scoped to them.
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-replies-student]');
      if (!b) return;
      actions.openRepliesDialog(b.dataset.repliesStudent);
    });

    // (Rename via double-click removed — students now change their own
    // username from the Student page, with PIN re-auth. The gradebook
    // here treats the name as a pure label.)
  }

  // ---------------- Init ----------------
  function init() {
    wireEvents();
    subscribe(render);
    render();

    // Hydrate the gradebook from the server on first paint. The server is the
    // source of truth for *who exists* — so a fresh signup is visible the next
    // time the teacher opens the page, without needing a manual refresh.
    actions.refreshStudents();

    // Pull the active + archive content from the server. The challenge
    // and the notifications now share this single endpoint.
    actions.loadContent();

    // Pull the replies grouped by student. The gradebook's per-row
    // "Replies" button uses this to open the dialog pre-filtered; we
    // pre-fetch so the dialog opens instantly the first time.
    actions.loadReplies();

    // Keep the gradebook + content in sync with the server while the
    // tab is open. Without this, an award made in another tab (or on
    // the server via the Student page's Edit-Username flow) wouldn't
    // show up here until a manual reload. 30s is a good balance —
    // fast enough to feel live, slow enough to not hammer the server.
    setInterval(() => {
      actions.refreshStudents();
      actions.loadContent();
      actions.loadReplies();
    }, 30 * 1000);

    // Welcome popup: show it whenever the Teacher page is opened.
    // Closing it still dismisses it for the current page; a new page load
    // starts with the welcome visible again.
    actions.openWelcome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

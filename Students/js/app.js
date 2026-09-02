/* ============================================================
   Student Score Tracker — Website
   Vanilla JS reactive store + localStorage persistence.
   Mirrors the Android MVVM / UDF architecture:
     - State (single source of truth)
     - subscribe() -> re-render
     - actions()  -> mutate state -> persist -> re-render
   ============================================================ */

(function () {
  'use strict';

  // ---------------- Constants ----------------
  const STORAGE_KEY = 'sst.students.v1';
  const CHALLENGE_KEY = 'sst.challenge.v1';
  const CHALLENGE_HISTORY_PREVIEW = 5;
  const CHALLENGE_MAX_LEN = 120;
  const WELCOME_KEY  = 'sst.welcomed.v1';
  const AVATAR_PALETTE = ['#8B5CF6', '#10B981', '#F43F5E', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#6366F1'];

  // ---------------- Date helpers ----------------
  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function isYesterday(prevDateStr, todayStr) {
    if (!prevDateStr) return false;
    const prev = new Date(prevDateStr + 'T00:00:00');
    if (isNaN(prev.getTime())) return false;
    const today = new Date(todayStr + 'T00:00:00');
    if (isNaN(today.getTime())) return false;
    const oneDay = 24 * 60 * 60 * 1000;
    return (today - prev) === oneDay;
  }
  function emptyChallenge(dateStr) {
    return { date: dateStr, text: '', done: false, doneAt: null };
  }

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
    snackbar: null,       // { id, message }
  };
  let state = loadState();
  state.challenge = loadChallenge();
  let challengeHistoryExpanded = false;

  // ---------------- Persistence ----------------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...initial, students: [], nextId: 1 };
      const parsed = JSON.parse(raw);
      const students = Array.isArray(parsed.students) ? parsed.students : [];
      // Backfill: ensure every student has a history array
      students.forEach(s => { if (!Array.isArray(s.history)) s.history = []; });
      return {
        ...initial,
        students,
        nextId: typeof parsed.nextId === 'number' ? parsed.nextId : 1,
      };
    } catch (err) {
      console.warn('Failed to load state, starting fresh.', err);
      return { ...initial, students: [], nextId: 1 };
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        students: state.students,
        nextId: state.nextId,
      }));
    } catch (err) {
      console.warn('Failed to persist state.', err);
    }
  }

  // ---------------- Challenge persistence ----------------
  function loadChallenge() {
    const today = todayKey();
    let saved = { date: today, text: '', done: false, doneAt: null, history: [] };
    try {
      const raw = localStorage.getItem(CHALLENGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          saved = {
            date: typeof parsed.date === 'string' ? parsed.date : today,
            text: typeof parsed.text === 'string' ? parsed.text : '',
            done: parsed.done === true,
            doneAt: typeof parsed.doneAt === 'number' ? parsed.doneAt : null,
            history: Array.isArray(parsed.history) ? parsed.history.filter(isValidHistoryEntry) : [],
          };
        }
      }
    } catch (err) {
      console.warn('Failed to load challenge, starting fresh.', err);
    }

    // Day-roll on load: archive the previous day if it's a different local date
    if (saved.date !== today) {
      if (saved.text && saved.text.trim().length > 0) {
        saved.history.unshift({
          date: saved.date,
          text: saved.text,
          done: saved.done === true,
          doneAt: typeof saved.doneAt === 'number' ? saved.doneAt : null,
        });
      }
      saved = { date: today, text: '', done: false, doneAt: null, history: saved.history };
    }
    return saved;
  }

  function isValidHistoryEntry(e) {
    return e && typeof e === 'object'
      && typeof e.date === 'string'
      && typeof e.text === 'string';
  }

  function persistChallenge() {
    try {
      localStorage.setItem(CHALLENGE_KEY, JSON.stringify({
        date: state.challenge.date,
        text: state.challenge.text,
        done: state.challenge.done,
        doneAt: state.challenge.doneAt,
        history: state.challenge.history,
      }));
    } catch (err) {
      console.warn('Failed to persist challenge.', err);
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

  // ---------------- Challenge selectors ----------------
  // Newest-first history is what we store. We need oldest-first to compute streaks
  // because consecutive done days are contiguous in the date axis.
  function challengeHistoryOldestFirst() {
    if (!state.challenge || !Array.isArray(state.challenge.history)) return [];
    return state.challenge.history.slice().reverse();
  }

  function currentStreak() {
    // Walk from newest to oldest; the streak is the run of consecutive done days
    // that includes today (if today is done) or yesterday (if today isn't set yet).
    const today = state.challenge.date;
    const todayDone = state.challenge.done === true;
    // If today has a challenge set and is done, start counting from today.
    // If today has a challenge set but is not done, the active streak is whatever
    // ended yesterday (we don't count today as a miss until the day rolls over).
    // If today is empty, the active streak is whatever ended yesterday.
    const hist = state.challenge.history || [];

    let streak = todayDone ? 1 : 0;
    // Anchor: the most recent history day we should consider "the end" of the run.
    // If today is done, the run starts at today and extends backwards through
    // history. If today is not done, the run starts at the most recent history day.
    let expectedPrev = null;
    if (todayDone) {
      expectedPrev = previousDateKey(today);
    } else if (hist.length > 0) {
      // Start from the newest history day and walk back.
      // Only count if the most recent history day was done.
      if (hist[0].done) {
        streak = 1;
        expectedPrev = previousDateKey(hist[0].date);
      } else {
        return 0;
      }
    } else {
      return 0;
    }

    // Walk history from index 1 forward (oldest direction), as long as each entry
    // is done and the date is exactly the day before the previous one.
    for (let i = todayDone ? 0 : 1; i < hist.length; i++) {
      const entry = hist[i]; // hist is newest-first, so this is the next-older entry
      if (!entry.done) break;
      if (entry.date !== expectedPrev) break;
      streak += 1;
      expectedPrev = previousDateKey(entry.date);
    }
    return streak;
  }

  function previousDateKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function longestStreak() {
    // Walk oldest -> newest and find the longest run of consecutive done days.
    const ordered = challengeHistoryOldestFirst();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const entry of ordered) {
      if (!entry.done) {
        run = 0;
      } else {
        // entry is consecutive with prev if entry.date is the day AFTER prev.date.
        const isConsecutive = prev !== null && entry.date === nextDateKey(prev);
        run = (prev === null || !isConsecutive) ? 1 : run + 1;
      }
      if (run > best) best = run;
      prev = entry.date;
    }
    return best;
  }

  function nextDateKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---------------- Challenge helpers (used by actions) ----------------
  function rollChallengeIfNewDay() {
    if (!state.challenge) state.challenge = emptyChallenge(todayKey());
    const today = todayKey();
    if (state.challenge.date === today) return;
    // Archive the previous day if there was a real challenge
    if (state.challenge.text && state.challenge.text.trim().length > 0) {
      state.challenge.history.unshift({
        date: state.challenge.date,
        text: state.challenge.text,
        done: state.challenge.done === true,
        doneAt: typeof state.challenge.doneAt === 'number' ? state.challenge.doneAt : null,
      });
    }
    state.challenge = emptyChallenge(today);
    persistChallenge();
  }

  // Compute streak from a challenge slice (state.challenge + history). Used
  // both by the live selector and by the action's snackbar message.
  function computeStreakForState(challenge) {
    const hist = Array.isArray(challenge.history) ? challenge.history : [];
    const todayDone = challenge.done === true;
    let streak = todayDone ? 1 : 0;
    let expectedPrev = null;
    if (todayDone) {
      expectedPrev = previousDateKey(challenge.date);
    } else if (hist.length > 0) {
      if (!hist[0].done) return 0;
      streak = 1;
      expectedPrev = previousDateKey(hist[0].date);
    } else {
      return 0;
    }
    const start = todayDone ? 0 : 1;
    for (let i = start; i < hist.length; i++) {
      const entry = hist[i];
      if (!entry.done) break;
      if (entry.date !== expectedPrev) break;
      streak += 1;
      expectedPrev = previousDateKey(entry.date);
    }
    return streak;
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
      });
      return ok;
    },

    renameStudent(id, name)   {
      const trimmed = (name || '').trim();
      if (!trimmed) return false;
      update(s => {
        const stu = s.students.find(x => x.id === id);
        if (!stu) return;
        if (stu.studentName === trimmed) return;
        stu.studentName = trimmed;
        stu.updatedAt = Date.now();
        s.snackbar = { id: Date.now(), message: `Renamed to ${trimmed}` };
      });
      return true;
    },

    openMemberDialog(tab = 'active') { update(s => { s.memberDialog = { open: true, tab }; }); },
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
      update(s => {
        const stu = s.students.find(x => x.id === s.deleteDialog.studentId);
        if (!stu) return;
        const name = stu.studentName;
        s.students = s.students.filter(x => x.id !== stu.id);
        s.deleteDialog = { open: false, studentId: null };
        s.snackbar = { id: Date.now(), message: `Deleted ${name}` };
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

    // ---- Daily challenge ----
    setTodayChallenge(text) {
      const trimmed = (text || '').trim().slice(0, CHALLENGE_MAX_LEN);
      if (!trimmed) {
        update(s => { s.snackbar = { id: Date.now(), message: 'Type a challenge first.' }; });
        return false;
      }
      // Roll the day if needed before mutating.
      rollChallengeIfNewDay();
      const today = state.challenge.date;
      update(s => {
        s.challenge.text = trimmed;
        s.snackbar = { id: Date.now(), message: 'Challenge saved for today.' };
      });
      persistChallenge();
      return true;
    },

    markChallengeDone() {
      rollChallengeIfNewDay();
      if (!state.challenge.text) {
        update(s => { s.snackbar = { id: Date.now(), message: 'Set a challenge first.' }; });
        return false;
      }
      if (state.challenge.done) return false;
      update(s => {
        const now = Date.now();
        s.challenge.done = true;
        s.challenge.doneAt = now;
        const newStreak = computeStreakForState(s.challenge);
        s.snackbar = { id: now, message: `Challenge done. ${newStreak}-day streak.` };
      });
      persistChallenge();
      return true;
    },

    unmarkChallengeDone() {
      rollChallengeIfNewDay();
      if (!state.challenge.done) return false;
      update(s => {
        s.challenge.done = false;
        s.challenge.doneAt = null;
        s.snackbar = { id: Date.now(), message: 'Challenge reset.' };
      });
      persistChallenge();
      return true;
    },

    clearChallengeHistory() {
      if (!state.challenge.history.length) return;
      update(s => {
        s.challenge.history = [];
        s.snackbar = { id: Date.now(), message: 'History cleared.' };
      });
      persistChallenge();
    },

    toggleChallengeHistory() {
      challengeHistoryExpanded = !challengeHistoryExpanded;
      renderChallenge();
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

  // ---------------- Submissions (student messages) ----------------
  async function loadSubmissions() {
    try {
      const res = await fetch('/api/submissions', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const list = (data && Array.isArray(data.submissions)) ? data.submissions : [];
      update(s => {
        s.messages = list;
        s.messagesLoaded = true;
      });
    } catch (err) {
      console.warn('Could not load student messages:', err);
      update(s => {
        s.messages = [];
        s.messagesLoaded = true;
      });
    }
  }

  function refreshMessagesBadge() {
    const badge = $('#messagesBadge');
    if (!badge) return;
    const n = (state.messages || []).length;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // ---------------- Renderers ----------------
  function render() {
    // If the user has the app open across midnight, refresh the daily challenge
    // so a new day shows a clean slate. Persisted on the spot.
    rollChallengeIfNewDay();

    renderBrand();
    $('#copyAllBtn').disabled = state.students.length === 0;
    renderStats();
    renderChallenge();
    renderGradebook();
    renderDialogs();
    refreshMessagesBadge();
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

  // ---- Daily challenge renderer ----
  function renderChallenge() {
    const ch = state.challenge;
    if (!ch) return;

    // Date heading: "Today, 30 Aug" — friendly local date
    const todayDate = new Date(ch.date + 'T00:00:00');
    const todayLabel = isNaN(todayDate.getTime())
      ? 'Today'
      : `Today, ${todayDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    $('#challengeDate').textContent = todayLabel;

    // State machine: empty (no text) / edit (text, not done) / done (text + done)
    const hasText = ch.text && ch.text.trim().length > 0;
    const isDone = ch.done === true;

    $('#challengeEmpty').hidden = hasText;
    $('#challengeEdit').hidden  = !hasText || isDone;
    $('#challengeDone').hidden  = !(hasText && isDone);

    if (hasText && !isDone) {
      const input = $('#challengeInput');
      // Don't trample the user's typing if the field is focused
      if (document.activeElement !== input) {
        input.value = ch.text;
      }
    }
    if (hasText && isDone) {
      $('#challengeDoneText').textContent = ch.text;
    }

    // Lede copy
    const lede = !hasText
      ? 'Set one small commitment and show up for it.'
      : (isDone ? 'Beautifully done. See you tomorrow.' : 'One thing. Make it small enough to win.');
    $('#challengeLede').textContent = lede;

    // Streaks
    $('#streakCurrent').textContent = currentStreak();
    $('#streakBest').textContent    = longestStreak();

    // History panel
    const hist = Array.isArray(ch.history) ? ch.history : [];
    const hasHistory = hist.length > 0;
    const historyPanel = $('#challengeHistory');
    const openBtn = $('#challengeHistoryOpenBtn');

    // Auto-show the history panel if there's history and the user already opened it
    // (sticky: once expanded in this session, stays expanded).
    if (hasHistory && challengeHistoryExpanded) {
      historyPanel.hidden = false;
      openBtn.hidden = true;
    } else {
      historyPanel.hidden = true;
      openBtn.hidden = !hasHistory;
    }

    // Build the list (respect preview vs full)
    const list = $('#challengeHistoryList');
    const showAll = challengeHistoryExpanded;
    const visible = showAll ? hist : hist.slice(0, CHALLENGE_HISTORY_PREVIEW);

    if (!hasHistory) {
      list.innerHTML = `<li class="history-row history-row-empty">No history yet. Mark a challenge done to start your streak.</li>`;
    } else {
      list.innerHTML = visible.map(ev => {
        const chip = ev.done
          ? `<span class="status-chip status-active history-chip"><span class="dot"></span>Done</span>`
          : `<span class="status-chip status-ghost history-chip"><span class="dot"></span>Missed</span>`;
        return `
          <li class="history-row">
            <span class="history-row-date">${escapeHtml(fmtChallengeHistoryDate(ev.date))}</span>
            <span class="history-row-text">${escapeHtml(ev.text)}</span>
            ${chip}
          </li>
        `;
      }).join('');
    }

    // Show-all toggle: only when history is longer than the preview
    const toggleBtn = $('#challengeHistoryToggleBtn');
    if (hasHistory && hist.length > CHALLENGE_HISTORY_PREVIEW) {
      toggleBtn.hidden = false;
      toggleBtn.textContent = showAll ? 'Show less' : `Show all (${hist.length})`;
    } else {
      toggleBtn.hidden = true;
    }

    // Clear-history button only shows when there's actually something to clear
    $('#challengeHistoryClearBtn').hidden = !hasHistory;
  }

  function fmtChallengeHistoryDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No matches for "${escapeHtml(state.searchQuery)}".</td></tr>`;
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
                <div class="student-name student-name-editable" data-action="rename" data-id="${s.id}" title="Double-click to rename" tabindex="0" role="button" aria-label="Rename ${escapeHtml(s.studentName)}">${escapeHtml(s.studentName)}</div>
                <div class="student-meta">last awarded ${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</div>
              </div>
            </div>
          </td>
          <td><span class="score-pill">${fmtScore(s.score)}</span></td>
          <td>
            <div class="history-cell">
              <button class="btn-icon-history" data-action="history" data-id="${s.id}" title="View award history" aria-label="View award history">
                <img src="assets/history.png" alt="" aria-hidden="true">
              </button>
            </div>
          </td>
          <td>
            <div class="action-row">
              <button class="btn-icon" data-action="award" data-id="${s.id}" title="Award points" aria-label="Award points">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
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
              <div class="student-name student-name-editable" data-action="rename" data-id="${s.id}" title="Double-click to rename" tabindex="0" role="button" aria-label="Rename ${escapeHtml(s.studentName)}">${escapeHtml(s.studentName)}</div>
              <div class="student-meta">last awarded ${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</div>
            </div>
            <div class="history-cell">
              <button class="btn-icon-history" data-action="history" data-id="${s.id}" title="View award history" aria-label="View award history">
                <img src="assets/history.png" alt="" aria-hidden="true">
              </button>
            </div>
          </div>
          <div class="student-card-stats">
            <span class="score-pill">${fmtScore(s.score)} pts</span>
          </div>
          <div class="student-card-actions">
            <button class="btn btn-primary" data-action="award" data-id="${s.id}">+ Award</button>
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

    // (Edit Student dialog removed — rename via double-click on student name)

    // History
    $('#historyDialog').hidden = !state.historyDialog.open;
    if (state.historyDialog.open) renderHistoryDialog();

    // Member dialog
    $('#memberDialog').hidden = !state.memberDialog.open;
    if (state.memberDialog.open) renderMemberDialog();

    // Delete
    $('#deleteDialog').hidden = !state.deleteDialog.open;
    if (state.deleteDialog.open) {
      const stu = state.students.find(s => s.id === state.deleteDialog.studentId);
      if (stu) $('#deleteName').textContent = stu.studentName;
    }

    // Docs
    $('#docsDialog').hidden = !state.docsDialog;

    // Messages
    $('#messagesDialog').hidden = !state.messagesDialog;
    if (state.messagesDialog) renderMessagesDialog();

    // Welcome (first-visit only)
    $('#welcomeDialog').hidden = !state.welcomeDialog;
  }

  function renderMessagesDialog() {
    const list = $('#messagesList');
    const ctx  = $('#messagesContext');
    if (!list || !ctx) return;

    if (!state.messagesLoaded) {
      ctx.textContent = 'Loading…';
      list.innerHTML = '';
      return;
    }
    const messages = Array.isArray(state.messages) ? state.messages : [];
    if (messages.length === 0) {
      ctx.textContent = 'No messages yet.';
      list.innerHTML = `
        <div class="messages-empty">
          <div class="messages-empty-icon" aria-hidden="true">💌</div>
          <p>When students send a message from their page, it shows up here.</p>
        </div>
      `;
      return;
    }
    const n = messages.length;
    ctx.textContent = `${n} message${n === 1 ? '' : 's'} from your students · newest first`;
    list.innerHTML = messages.map(m => {
      const at = typeof m.at === 'number' ? m.at : Date.now();
      const name = (m.username || 'unknown').toString();
      return `
        <article class="message-row">
          <div class="message-row-head">
            <div class="avatar avatar-sm" style="background:${avatarColor(name)}">${escapeHtml(initials(name))}</div>
            <div class="message-row-name">${escapeHtml(name)}</div>
            <div class="message-row-time">${escapeHtml(fmtTimeAgo(at))}</div>
          </div>
          <blockquote class="message-text">${escapeHtml((m.text || '').toString())}</blockquote>
        </article>
      `;
    }).join('');
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
    container.innerHTML = list.map(s => `
      <div class="tab-panel-row">
        <div>
          <div class="row-name">${escapeHtml(s.studentName)}</div>
          <div class="row-meta">${fmtScore(s.score)} pts</div>
        </div>
        <span class="status-chip ${tab === 'active' ? 'status-active' : 'status-ghost'}">
          <span class="dot"></span>${tab === 'active' ? 'Active' : 'Ghost'}
        </span>
        <span class="award-pill">${escapeHtml(fmtTimeAgo(s.lastAwardedAt))}</span>
        <button class="btn btn-primary" data-action="award" data-id="${s.id}">+ Award</button>
      </div>
    `).join('');
  }

  // ---------------- Event wiring ----------------
  function wireEvents() {
    // Header
    $('#searchInput').addEventListener('input', e => actions.setSearch(e.target.value));
    $('#sortSelect').addEventListener('change', e => actions.setSort(e.target.value));
    $('#copyAllBtn').addEventListener('click', () => actions.copyAll());
    $('#copyLoginLinkBtn').addEventListener('click', async () => {
      const url = 'http://localhost:8001/';
      try {
        await navigator.clipboard.writeText(url);
        update(s => { s.snackbar = { id: Date.now(), message: 'Login page link copied — paste in WhatsApp' }; });
      } catch (err) {
        update(s => { s.snackbar = { id: Date.now(), message: "Couldn't copy. The link is " + url }; });
      }
    });
    $('#docsBtn').addEventListener('click', () => actions.openDocs());
    $('#messagesBtn').addEventListener('click', () => actions.openMessagesDialog());
    $('#memberStatusBtn').addEventListener('click', () => actions.openMemberDialog('active'));

    // Generic close buttons
    document.addEventListener('click', e => {
      const closeId = e.target.closest('[data-close-dialog]')?.dataset.closeDialog;
      if (closeId) {
        e.preventDefault();
        const dialog = $('#' + closeId);
        if (dialog === $('#addScoreDialog')) actions.closeAddScore();
        else if (dialog === $('#historyDialog')) actions.closeHistory();
        else if (dialog === $('#memberDialog')) actions.closeMemberDialog();
        else if (dialog === $('#deleteDialog')) actions.closeDelete();
        else if (dialog === $('#docsDialog')) actions.closeDocs();
        else if (dialog === $('#messagesDialog')) actions.closeMessagesDialog();
        else if (dialog === $('#welcomeDialog')) actions.closeWelcome();
      }
    });

    // Backdrop click closes
    $$('.dialog-backdrop').forEach(bd => {
      bd.addEventListener('click', e => {
        if (e.target !== bd) return;
        const id = bd.id;
        if (id === 'addScoreDialog') actions.closeAddScore();
        else if (id === 'historyDialog') actions.closeHistory();
        else if (id === 'memberDialog') actions.closeMemberDialog();
        else if (id === 'deleteDialog') actions.closeDelete();
        else if (id === 'docsDialog') actions.closeDocs();
        else if (id === 'messagesDialog') actions.closeMessagesDialog();
        else if (id === 'welcomeDialog') actions.closeWelcome();
      });
    });

    // Escape closes any open dialog
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (state.welcomeDialog)              actions.closeWelcome();
      else if (state.docsDialog)                actions.closeDocs();
      else if (state.messagesDialog)            actions.closeMessagesDialog();
      else if (state.addScoreDialog.open)      actions.closeAddScore();
      else if (state.historyDialog.open)       actions.closeHistory();
      else if (state.memberDialog.open)        actions.closeMemberDialog();
      else if (state.deleteDialog.open)        actions.closeDelete();
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
      const id = Number(trigger.dataset.id);
      const action = trigger.dataset.action;
      if (action === 'award')           actions.openAddScore(id);
      if (action === 'history')         actions.openHistory(id);
      if (action === 'delete')          actions.openDelete(id);
      if (action === 'pickHistory')     actions.pickHistoryStudent(id);
      if (action === 'openMessages')    actions.openMessagesDialog();
    });

    // Double-click a student name to rename
    document.addEventListener('dblclick', e => {
      const trigger = e.target.closest('[data-action="rename"]');
      if (!trigger) return;
      const id = Number(trigger.dataset.id);
      const stu = state.students.find(s => s.id === id);
      if (!stu) return;
      const next = window.prompt('Rename student', stu.studentName);
      if (next === null) return; // user cancelled
      actions.renameStudent(id, next);
    });

    // Daily challenge
    $('#challengeSaveBtn').addEventListener('click', () => {
      actions.setTodayChallenge($('#challengeInput').value);
    });
    $('#challengeInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        actions.setTodayChallenge(e.target.value);
      }
    });
    $('#challengeDoneBtn').addEventListener('click', () => {
      actions.markChallengeDone();
    });
    $('#challengeUnmarkBtn').addEventListener('click', () => {
      actions.unmarkChallengeDone();
    });
    $('#challengeHistoryOpenBtn').addEventListener('click', () => {
      actions.toggleChallengeHistory();
    });
    $('#challengeHistoryToggleBtn').addEventListener('click', () => {
      actions.toggleChallengeHistory();
    });
    $('#challengeHistoryClearBtn').addEventListener('click', () => {
      const ok = window.confirm('Clear all challenge history? This cannot be undone.');
      if (ok) actions.clearChallengeHistory();
    });
  }

  // ---------------- Init ----------------
  function init() {
    wireEvents();
    // Reflect loaded state into the data shape
    state.nextId = state.nextId || (state.students.reduce((m, s) => Math.max(m, s.id), 0) + 1);
    subscribe(render);
    render();

    // Pull student messages once on load (so the badge shows up if any
    // are waiting) and again every 60s while the tab is open. Cheap call,
    // and matches the polling cadence on the student page itself.
    loadSubmissions();
    setInterval(loadSubmissions, 60_000);

    // First-visit welcome: shows the very first time this tab opens the app.
    // The flag lives in sessionStorage (cleared when the tab/window closes), so
    // reloading the page keeps it hidden — but launching Start Website.bat again
    // opens a fresh tab/session, so the welcome reappears.
    let hasSeenWelcome = false;
    try { hasSeenWelcome = sessionStorage.getItem(WELCOME_KEY) === '1'; } catch (err) { /* ignore */ }
    if (!hasSeenWelcome) actions.openWelcome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

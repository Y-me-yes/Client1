# ============================================================
# 1% Healthy Habit — Auth backend (Python, no external deps)
# ------------------------------------------------------------
# Single-instance install. Defaults to port 3000.
#
# Endpoints
#   GET  /api/health                     -> 200 "ok"
#   POST /api/signup                     { username, pin, gmail? }
#   POST /api/signup-send-code           { username, pin, gmail }
#   POST /api/signin                     { username, pin }
#   POST /api/teacher-signin             { username, password }
#   POST /api/forgot                     { username }
#   POST /api/verify-code                { username, code, purpose }
#   POST /api/reset-with-pin             { resetToken, pin }
#   GET  /api/students                   -> [{id, username, createdAt}, ...]
#   POST /api/delete-student             { username, teacherPassword }
#   GET  /api/challenge                  -> {date, text}
#   PUT  /api/challenge                  { text, teacherPassword }   (legacy daily-challenge)
#   GET  /api/challenge/done?username=X  -> {done, doneAt}
#   POST /api/challenge/done             { username, mark }
#   GET  /api/students/<u>/points        -> {username, score, awardCount, lastAwardedAt, history}
#   PUT  /api/students/<u>/points        { score, awardCount, lastAwardedAt, history, teacherPassword }
#   GET  /api/gradebook                  -> [{id, username, createdAt, score, awardCount, lastAwardedAt, history}, ...]
#   POST /api/rename-username            { oldUsername, newUsername, pin }  (student re-auth)
#   GET  /api/content?username=X         -> {active:[...], archive:[...], studentArchive:[...], now}
#         (server records a view for `username` on every active notification)
#   POST /api/content                    { kind, text?, title?, body?, expiresAt?, returnType?, teacherPassword }
#         (kind ∈ "daily-challenge" | "new-challenge" | "notification" | "message")
#         returnType ∈ {"image","video","audio","text",null} — only for daily/new challenges
#   POST /api/content/<id>/archive       { teacherPassword }   (manual archive; works for any kind)
#   POST /api/signout                    { username }
#         Moves every active notification this student has viewed into
#         their per-student archive, then removes their username from
#         the global viewedBy set so the notification stays available
#         for the rest of the class.
#   GET  /api/student-archive?username=X -> { ok, items: [...] }
#   GET  /api/replies?parentId=X         -> { ok, items: [...] }   (all replies on one challenge/message)
#   GET  /api/replies?student=X          -> { ok, byStudent: {user: [...]} }  (for the Teacher's Replies section)
#   POST /api/replies                    multipart: parentId, parentKind, studentUsername, text?, mediaType?, media?
#         (parentKind ∈ {"challenge","message"}; mediaType ∈ {"image","video","audio",null})
#         Both `text` and the `media` part are independently optional,
#         but at least one must be non-empty. 15 MB upload cap.
#
# Storage: users.json + pendings.json + codes.json + resets.json
#           + .challenge.json + .challenge-done.json
#           + .notifications.json + .archive.json
#           + .messages.json + .replies.json + .student-archive.json
#           + media/   (uploaded reply media files, served at /media/<name>)
# Email:   smtplib + Gmail SMTP, uses GMAIL_APP_PASSWORD.
# ============================================================

import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import smtplib
import socketserver
import sys
import threading
import time
import urllib.parse
from email.mime.text import MIMEText
from pathlib import Path

# Optional dependencies — Mongo for hosted storage, Resend for hosted email.
# Both are present in requirements.txt. If either is missing on import,
# the server falls back to local JSON files (dev) or stderr email (dev).
try:
    import pymongo
    from pymongo import MongoClient
    _HAVE_PYMONGO = True
except Exception:
    pymongo = None
    MongoClient = None
    _HAVE_PYMONGO = False

try:
    import resend
    _HAVE_RESEND = True
except Exception:
    resend = None
    _HAVE_RESEND = False


# ---------- env loading (tiny .env parser — no external deps) ----------

def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env

ENV_PATH = Path(__file__).parent / ".env"
ENV_EXAMPLE_PATH = Path(__file__).parent / ".env.example"
ENV = load_env(ENV_PATH)
# fall back to .env.example so the server still boots if the user forgot to copy
if not ENV:
    ENV = load_env(ENV_EXAMPLE_PATH)

def env(key: str, default: str = "") -> str:
    return ENV.get(key, os.environ.get(key, default))

# ---------- config ----------

PORT            = int(env("PORT", "3000"))
PUBLIC_BASE_URL = env("PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")
FRONTEND_URL    = env("FRONTEND_URL", "http://localhost:8001").rstrip("/")
GMAIL_USER      = env("GMAIL_USER", "")
GMAIL_APP_PASS  = env("GMAIL_APP_PASSWORD", "")
MAIL_FROM_NAME  = env("MAIL_FROM_NAME", "Governor Yusuf")
WHATSAPP_NUMBER = env("WHATSAPP_NUMBER", "+234 814 159 4944")

# Teacher sign-in (shared secret — there is only ONE teacher account)
TEACHER_USERNAME    = env("TEACHER_USERNAME", "")
TEACHER_PASSWORD    = env("TEACHER_PASSWORD", "")
TEACHER_LANDING     = env("TEACHER_LANDING", "../Teacher's/index.html")
USER_LANDING        = env("USER_LANDING", "../Students/index.html")

DATA_DIR     = Path(__file__).parent
# STATIC_DIR is the project root (FINISHED/), one level up from
# server/. The Python process serves the four HTML pages out of here
# so a single Render web service can host the whole site + API.
STATIC_DIR   = DATA_DIR.parent
USERS_FILE    = DATA_DIR / "users.json"
PENDINGS_FILE = DATA_DIR / "pendings.json"
CODES_FILE    = DATA_DIR / "codes.json"
RESETS_FILE   = DATA_DIR / "resets.json"
CHALLENGE_FILE     = DATA_DIR / ".challenge.json"
CHALLENGE_DONE_FILE = DATA_DIR / ".challenge-done.json"
NOTIFICATIONS_FILE  = DATA_DIR / ".notifications.json"
ARCHIVE_FILE        = DATA_DIR / ".archive.json"
# Added in the "return type + messages" round: messages, replies,
# per-student archive, and the on-disk media/ folder for uploads.
MESSAGES_FILE        = DATA_DIR / ".messages.json"
REPLIES_FILE         = DATA_DIR / ".replies.json"
STUDENT_ARCHIVE_FILE = DATA_DIR / ".student-archive.json"
MEDIA_DIR            = DATA_DIR / "media"

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PIN_RE   = re.compile(r"^\d{6}$")

# ---------- storage ----------

_lock = threading.RLock()

# The storage layer is dual-backed: a Mongo collection if MONGODB_URI is
# set and pymongo is installed, otherwise a JSON file on local disk. The
# call sites (load_users, save_users, etc.) only see `load_X` / `save_X`
# functions that return / accept the raw parsed value, so swapping the
# backend doesn't ripple through the rest of the file.
#
# Each "JSON file" maps 1:1 to a Mongo collection. Inside that collection
# is a single document with _id='singleton' and a `value` field holding
# the parsed JSON. The kv shape is fine for our use — the entire users
# list is one document, the entire notifications list is one document, etc.
# The only "high-write" collection is `replies`, which is appended to on
# every student reply; for the demo this stays under 0.5 GB easily.
#
# The "points" use case (per-student score) is an exception: it lives on
# the users document in the JSON-file world, and we keep that here too —
# score/awardCount/lastAwardedAt/history ride along on the user row in
# the `users` collection.

_mongo_client = None
_mongo_db = None
_storage_mode = "json"  # or "mongo"

def _storage_init():
    """Initialise the storage backend. Mongo takes priority if available;
    otherwise we fall back to local JSON files (developer convenience)."""
    global _mongo_client, _mongo_db, _storage_mode
    uri = (os.environ.get("MONGODB_URI") or "").strip()
    if _HAVE_PYMONGO and uri:
        try:
            _mongo_client = MongoClient(uri, serverSelectionTimeoutMS=5000, uuidRepresentation="standard")
            # Force a round-trip to fail fast if creds are wrong.
            _mongo_client.admin.command("ping")
            db_name = os.environ.get("MONGODB_DB") or "client1"
            _mongo_db = _mongo_client[db_name]
            _storage_mode = "mongo"
            print(f"[store] Mongo backend ready (db={db_name})", file=sys.stderr)
            return
        except Exception as e:
            print(f"[store] Mongo init failed ({e}); falling back to local JSON.", file=sys.stderr)
            _mongo_client = None
            _mongo_db = None
    print(f"[store] Using local JSON files in {DATA_DIR}", file=sys.stderr)
    _storage_mode = "json"

def _storage_indexes():
    """One-time index bootstrap. Mongo collections are schemaless but we
    still want unique keys on the things that JSON files had to dedupe by
    hand (username, code key, etc.)."""
    if _storage_mode != "mongo" or _mongo_db is None:
        return
    try:
        # The 'users' collection is a single document with the whole
        # list in `value`, so we can't index a username field at the
        # collection level. We add a tiny secondary collection that
        # mirrors username → _id for fast lookup; writes go through the
        # helper functions so both stay in sync.
        _mongo_db["users_by_username"].create_index("username", unique=True)
        _mongo_db["codes"].create_index("key", unique=True)
        _mongo_db["resets"].create_index("token", unique=True)
        _mongo_db["pendings"].create_index("username", unique=True)
    except Exception as e:
        print(f"[store] index bootstrap failed: {e}", file=sys.stderr)

def _read(name: str, default):
    """Read a "file" by name (e.g. "users", ".challenge"). On Mongo this
    is a collection; on JSON this is a file in DATA_DIR. The argument
    is a name (no leading dot) so we don't have path-handling code in
    every call site."""
    if _storage_mode == "mongo" and _mongo_db is not None:
        try:
            doc = _mongo_db[name].find_one({"_id": "singleton"})
            if not doc or "value" not in doc:
                return default
            return doc["value"]
        except Exception as e:
            print(f"[store:mongo] read {name} failed: {e}", file=sys.stderr)
            return default
    # JSON-file fallback
    # Accept either "users" or ".users" — keep the historical dotted
    # names for dev parity.
    file_name = name if name.startswith(".") else f".{name}.json"
    if name == "users":       file_name = "users.json"
    if name == "pendings":    file_name = "pendings.json"
    if name == "codes":       file_name = "codes.json"
    if name == "resets":      file_name = "resets.json"
    path = DATA_DIR / file_name
    if not path.exists():
        return default
    try:
        txt = path.read_text(encoding="utf-8").strip()
        return json.loads(txt) if txt else default
    except Exception as e:
        print(f"[store:json] read {path.name} failed: {e}", file=sys.stderr)
        return default

def _write(name: str, data) -> None:
    if _storage_mode == "mongo" and _mongo_db is not None:
        try:
            _mongo_db[name].replace_one(
                {"_id": "singleton"},
                {"_id": "singleton", "value": data},
                upsert=True,
            )
            return
        except Exception as e:
            print(f"[store:mongo] write {name} failed: {e}", file=sys.stderr)
            return
    file_name = name if name.startswith(".") else f".{name}.json"
    if name == "users":       file_name = "users.json"
    if name == "pendings":    file_name = "pendings.json"
    if name == "codes":       file_name = "codes.json"
    if name == "resets":      file_name = "resets.json"
    path = DATA_DIR / file_name
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

# Backwards-compat: the original _read/_write took a Path. The new ones
# take a name. Keep a Path-accepting shim so the many call sites
# throughout the file don't need to be touched.
def _read_path(path: Path, default):
    # Strip DATA_DIR prefix + .json suffix to get the original name.
    # Examples: DATA_DIR / "users.json" -> "users",
    #           DATA_DIR / ".challenge.json" -> "challenge"
    # (The path's basename is "X.json" or ".X.json" where X is the
    # collection name.)
    base = path.name
    if base.startswith("."):
        return _read(base[1:].rsplit(".json", 1)[0], default)
    return _read(base.rsplit(".json", 1)[0], default)

def _write_path(path: Path, data) -> None:
    base = path.name
    if base.startswith("."):
        return _write(base[1:].rsplit(".json", 1)[0], data)
    return _write(base.rsplit(".json", 1)[0], data)

def load_users()    : return _read_path(USERS_FILE, [])
def save_users(u)   : _write_path(USERS_FILE, u)
def load_pendings() : return _read_path(PENDINGS_FILE, {})
def save_pendings(p): _write_path(PENDINGS_FILE, p)
def load_codes()    : return _read_path(CODES_FILE, {})
def save_codes(c)   : _write_path(CODES_FILE, c)
def load_resets()   : return _read_path(RESETS_FILE, {})
def save_resets(r)  : _write_path(RESETS_FILE, r)
def load_challenge():      return _read_path(CHALLENGE_FILE, {})
def save_challenge(c):     _write_path(CHALLENGE_FILE, c)
def load_challenge_done(): return _read_path(CHALLENGE_DONE_FILE, {})
def save_challenge_done(d): _write_path(CHALLENGE_DONE_FILE, d)
def load_notifications():  return _read_path(NOTIFICATIONS_FILE, [])
def save_notifications(n): _write_path(NOTIFICATIONS_FILE, n)
def load_archive():        return _read_path(ARCHIVE_FILE, [])
def save_archive(a):       _write_path(ARCHIVE_FILE, a)
def load_messages():        return _read_path(MESSAGES_FILE, [])
def save_messages(m):       _write_path(MESSAGES_FILE, m)
def load_replies():         return _read_path(REPLIES_FILE, [])
def save_replies(r):        _write_path(REPLIES_FILE, r)
def load_student_archive(): return _read_path(STUDENT_ARCHIVE_FILE, [])
def save_student_archive(s): _write_path(STUDENT_ARCHIVE_FILE, s)

# ---------- rate limiting ----------
# Without throttling, an attacker on the same network as the dev box can
# brute-force a 6-digit PIN in seconds (only 1M combinations) and an
# attacker on the open internet can probe usernames. Lock out a key for
# a cooldown window after a small number of failures. Two keys are
# tracked: per-username and per-client-IP, both with their own budget.

_LOGIN_MAX_FAILS    = 5
_LOGIN_WINDOW_MS    = 60 * 1000
_LOGIN_LOCKOUT_MS   = 5 * 60 * 1000

_CODE_MAX_FAILS     = 8
_CODE_WINDOW_MS     = 15 * 60 * 1000
_CODE_LOCKOUT_MS    = 15 * 60 * 1000

# Per-key state: key -> {"fails": [ms-timestamp, ...], "lockedUntil": ms-timestamp}
_login_buckets: dict = {}
_code_buckets:  dict = {}
# Buckets for /api/content GETs (per-IP) and POSTs (per-teacher). These are
# separate from _login_buckets so a content poll doesn't share a budget
# with sign-in.
_content_view_buckets: dict = {}
_content_post_buckets: dict = {}
# /api/replies (multipart upload) — separate buckets so a runaway client
# can't burn the read budget. Per-student cap to stop a single tab from
# filling the disk; per-IP cap for general abuse.
_reply_post_buckets: dict = {}
_reply_get_buckets:  dict = {}

# Max upload size for /api/replies. Audio recordings and short videos
# are tiny; a 15 MB cap is generous without bloating media/.
_REPLY_MAX_MEDIA_BYTES = 15 * 1024 * 1024

def _rl_now() -> int:
    return int(time.time() * 1000)

def _client_ip(handler) -> str:
    # Honor X-Forwarded-For if a reverse proxy set it; otherwise the socket peer.
    fwd = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    if fwd:
        return fwd
    try:
        return handler.client_address[0]
    except Exception:
        return "unknown"

def _rl_consume(buckets: dict, key: str, now: int, max_fails: int, window_ms: int, lockout_ms: int):
    """Rate limiting is disabled — return (not locked) so call sites still work."""
    return False, 0

def _rl_success(buckets: dict, key: str) -> None:
    """No-op when rate limiting is disabled."""
    return

def _rl_locked_response(retry_after_ms: int):
    """Return the standard 429 response payload, or None if not locked."""
    seconds = max(1, (retry_after_ms + 999) // 1000)
    return {
        "error": f"Too many attempts. Try again in {seconds} seconds.",
        "retryAfter": seconds,
    }

# ---------- password hashing (PBKDF2-HMAC-SHA256) ----------

_ITERATIONS = 100_000

def hash_pin(pin: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), _ITERATIONS).hex()
    return f"{salt}${h}"

def verify_pin(pin: str, stored: str) -> bool:
    if not stored or "$" not in stored:
        return False
    salt, h = stored.split("$", 1)
    test = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), _ITERATIONS).hex()
    return hmac.compare_digest(h, test)

# ---------- 5-digit codes + reset tokens ----------

def new_code() -> str:
    return f"{secrets.randbelow(100000):05d}"

def issue_code(username: str, purpose: str) -> str:
    with _lock:
        codes = load_codes()
        key = f"{username.lower()}::{purpose}"
        code = new_code()
        codes[key] = {
            "code": code,
            "purpose": purpose,
            "attempts": 0,
            "createdAt": int(time.time() * 1000),
            "expiresAt": int(time.time() * 1000) + 15 * 60 * 1000,  # 15 min
        }
        save_codes(codes)
        return code

def consume_code(username: str, code: str, purpose: str):
    with _lock:
        codes = load_codes()
        key = f"{username.lower()}::{purpose}"
        entry = codes.get(key)
        if not entry:
            return {"error": "No code on file. Request a new one."}
        if entry["purpose"] != purpose:
            return {"error": "Wrong code type."}
        if time.time() * 1000 > entry["expiresAt"]:
            codes.pop(key, None); save_codes(codes)
            return {"error": "That code has expired. Request a new one."}
        entry["attempts"] = entry.get("attempts", 0) + 1
        if entry["attempts"] > 8:
            codes.pop(key, None); save_codes(codes)
            return {"error": "Too many wrong attempts. Request a new code."}
        if entry["code"] != code:
            save_codes(codes)
            return {"error": "That code didn't match. Try again."}
        codes.pop(key, None); save_codes(codes)
        return {"ok": True}

def issue_reset_token(username: str) -> str:
    with _lock:
        resets = load_resets()
        token = secrets.token_hex(24)
        resets[token] = {
            "username": username.lower(),
            "createdAt": int(time.time() * 1000),
            "expiresAt": int(time.time() * 1000) + 10 * 60 * 1000,  # 10 min
        }
        save_resets(resets)
        return token

def consume_reset_token(token: str):
    with _lock:
        resets = load_resets()
        entry = resets.get(token)
        if not entry:
            return None
        resets.pop(token, None); save_resets(resets)
        if time.time() * 1000 > entry["expiresAt"]:
            return None
        return entry

# ---------- email (lazy + safe) ----------

# Two backends:
#   - Resend (HTTPS API) when RESEND_API_KEY is set. Works on Render's
#     free tier (which blocks outbound SMTP). This is the preferred
#     path on hosted deploys.
#   - Gmail SMTP (smtplib) when only GMAIL_USER + GMAIL_APP_PASSWORD
#     are set. Used for local dev with a real Gmail account.
#   - Neither configured? Fall back to logging the message to stderr
#     so the request still succeeds (the 5-digit code is visible in
#     the server logs).

RESEND_API_KEY = env("RESEND_API_KEY", "")
MAIL_FROM      = env("MAIL_FROM", "onboarding@resend.dev")
MAIL_FROM_NAME = env("MAIL_FROM_NAME", "Governor Yusuf")

def can_send_email() -> bool:
    return bool(RESEND_API_KEY) or (bool(GMAIL_USER) and bool(GMAIL_APP_PASS) and not GMAIL_APP_PASS.startswith("replace_"))

def _send_via_resend(to: str, subject: str, text: str) -> bool:
    if not (_HAVE_RESEND and RESEND_API_KEY):
        return False
    try:
        resend.api_key = RESEND_API_KEY
        from_email = f"{MAIL_FROM_NAME} <{MAIL_FROM}>" if MAIL_FROM_NAME else MAIL_FROM
        resend.Emails.send({
            "from": from_email,
            "to":   [to],
            "subject": subject,
            "text": text,
        })
        return True
    except Exception as e:
        print(f"[email:resend] send failed: {e}", file=sys.stderr)
        return False

def _send_via_gmail(to: str, subject: str, text: str) -> bool:
    if not (GMAIL_USER and GMAIL_APP_PASS and not GMAIL_APP_PASS.startswith("replace_")):
        return False
    try:
        msg = MIMEText(text, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"]    = f"{MAIL_FROM_NAME} <{GMAIL_USER}>"
        msg["To"]      = to
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as s:
            s.login(GMAIL_USER, GMAIL_APP_PASS)
            s.send_message(msg)
        return True
    except Exception as e:
        print(f"[email:gmail] send failed: {e}", file=sys.stderr)
        return False

def send_email(to: str, subject: str, text: str) -> None:
    """Best-effort send. Tries Resend first (the hosted path), then
    Gmail (the dev path), then logs to stderr. Returns nothing — the
    caller should not treat email failure as fatal."""
    if _send_via_resend(to, subject, text):
        print(f"[email] sent (resend) \"{subject}\" to {to}", file=sys.stderr)
        return
    if _send_via_gmail(to, subject, text):
        print(f"[email] sent (gmail) \"{subject}\" to {to}", file=sys.stderr)
        return
    print(f"[email] SKIPPED (no RESEND_API_KEY and no Gmail configured). Would have sent to {to}: \"{subject}\"\n--- BODY ---\n{text}\n--- END ---", file=sys.stderr)

# ---------- HTTP server ----------

def _today_key() -> str:
    """Local-day key in YYYY-MM-DD, matching what the client uses for 'today'."""
    t = time.localtime()
    return f"{t.tm_year:04d}-{t.tm_mon:02d}-{t.tm_mday:02d}"

def _match_student_points(path: str):
    """Return the lowercased username from /api/students/<u>/points,
    or None if the path doesn't match. We deliberately do not allow
    slashes inside <u> so a path like /api/students/foo/bar/points
    doesn't sneak a second segment through."""
    if not path.startswith("/api/students/"):
        return None
    if not path.endswith("/points"):
        return None
    middle = path[len("/api/students/"):-len("/points")]
    if not middle or "/" in middle:
        return None
    return urllib.parse.unquote(middle).strip().lower() or None

def _match_content_archive(path: str):
    """Return the content id from /api/content/<id>/archive, or None
    if the path doesn't match. We accept a few shapes:
        /api/content/<id>/archive
    Anything else (e.g. /api/content/123, /api/content/abc/foo) returns None.
    IDs may contain [A-Za-z0-9_-]; the server's id is a 16-char hex but
    we accept a slightly broader alphabet for forward-compat."""
    if not path.startswith("/api/content/"):
        return None
    if not path.endswith("/archive"):
        return None
    middle = path[len("/api/content/"):-len("/archive")]
    if not middle or "/" in middle:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_-]+", middle):
        return None
    return middle

def _send(handler, status: int, body: dict):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
    handler.end_headers()
    handler.wfile.write(payload)

def _read_json(handler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if not length:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}

class Handler(http.server.BaseHTTPRequestHandler):
    # silence the default per-request stderr access log
    def log_message(self, fmt, *args):  # noqa: N802
        pass

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/api/health" or self.path == "/health":
            return _send(self, 200, {"ok": True, "storage": _storage_mode})
        # Serve static files from the project root (FINISHED/) so the
        # hosted service can serve Login/, Students/, Student/, Teacher's/
        # out of the same Python process. The static dir is the parent
        # of DATA_DIR (= server/).
        try:
            return self._serve_static(self.path)
        except _NotStatic:
            pass
        # /healthz (Render's default) — alias
        if self.path == "/healthz":
            return _send(self, 200, {"ok": True, "storage": _storage_mode})
        # /healthz (Render's default) — alias
        if self.path == "/healthz":
            return _send(self, 200, {"ok": True, "storage": _storage_mode})
        if self.path == "/api/students":
            return self._list_students()
        if self.path == "/api/gradebook":
            return self._gradebook()
        if self.path == "/api/challenge":
            return self._get_challenge()
        # /api/content (with optional ?username= and ?includeArchive=)
        if self.path == "/api/content" or self.path.startswith("/api/content?"):
            return self._get_content()
        # /api/student-archive?username=X
        if self.path == "/api/student-archive" or self.path.startswith("/api/student-archive?"):
            return self._get_student_archive()
        # /api/replies?parentId=X OR /api/replies?student=X
        if self.path == "/api/replies" or self.path.startswith("/api/replies?"):
            return self._get_replies()
        # /api/challenge/done?username=X
        if self.path.startswith("/api/challenge/done"):
            return self._get_challenge_done()
        # /api/students/<username>/points
        pts = _match_student_points(self.path)
        if pts:
            return self._get_student_points(pts)
        # /media/<file> — uploaded reply media. Served straight from
        # the on-disk folder; the file name is server-generated so
        # there's no traversal surface as long as we resolve against
        # MEDIA_DIR.
        if self.path.startswith("/media/"):
            return self._serve_media(self.path[len("/media/"):])
        return _send(self, 404, {"error": "Not found"})

    def do_POST(self):  # noqa: N802
        if   self.path == "/api/signup":            return self._signup()
        elif self.path == "/api/signup-send-code":  return self._signup_send_code()
        elif self.path == "/api/signin":            return self._signin()
        elif self.path == "/api/teacher-signin":    return self._teacher_signin()
        elif self.path == "/api/delete-student":    return self._delete_student()
        elif self.path == "/api/forgot":            return self._forgot()
        elif self.path == "/api/verify-code":       return self._verify_code()
        elif self.path == "/api/reset-with-pin":    return self._reset_with_pin()
        elif self.path == "/api/challenge/done":    return self._post_challenge_done()
        elif self.path == "/api/rename-username":   return self._rename_username()
        elif self.path == "/api/content":           return self._post_content()
        elif self.path == "/api/signout":           return self._post_signout()
        elif self.path == "/api/replies":           return self._post_replies()
        # /api/content/<id>/archive
        cid = _match_content_archive(self.path)
        if cid is not None:
            return self._post_content_archive(cid)
        return _send(self, 404, {"error": "Not found"})

    def do_PUT(self):  # noqa: N802
        print(f"[debug-PUT] path={self.path!r} cl={self.headers.get('Content-Length')!r} te={self.headers.get('Transfer-Encoding')!r} ct={self.headers.get('Content-Type')!r}", file=sys.stderr, flush=True)
        if self.path == "/api/challenge":
            return self._put_challenge()
        pts = _match_student_points(self.path)
        if pts:
            return self._put_student_points(pts)
        return _send(self, 404, {"error": "Not found"})

    # --- handlers ---

    def _signup(self):
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        pin      = str(body.get("pin")      or "").strip()
        gmail    = str(body.get("gmail")    or "").strip()

        if len(username) < 3:
            return _send(self, 400, {"error": "Username must be at least 3 characters."})
        if not PIN_RE.match(pin):
            return _send(self, 400, {"error": "Please, enter a six digit password."})
        if gmail and not EMAIL_RE.match(gmail):
            return _send(self, 400, {"error": "Enter a valid Gmail address."})

        # Throttle account-creation flooding (esp. email bombing when
        # the user supplies a Gmail).
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"signup:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _code_buckets, key, now_ms,
                _CODE_MAX_FAILS, _CODE_WINDOW_MS, _CODE_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        # If a Gmail is supplied, the user MUST verify the 5-digit code
        # before the row lands in users.json. A username is only
        # "taken" once the verification completes. Callers should hit
        # /api/signup-send-code first and /api/verify-code second; we
        # bounce the bare /api/signup path when a Gmail is in play so
        # a half-finished signup can't lock the username.
        if gmail:
            return _send(self, 400, {
                "error": "Verify your Gmail first. We sent a 5-digit code to it — open the code window to finish creating your account."
            })

        with _lock:
            users = load_users()
            if any((u.get("gmail") or "").lower() == gmail.lower() for u in users if gmail):
                return _send(self, 409, {"error": "An account with that Gmail already exists. Sign in instead."})
            if any(u["username"].lower() == username.lower() for u in users):
                return _send(self, 409, {"error": "That username is taken. Try another."})

            user = {
                "id": secrets.token_hex(8),
                "username": username,
                "pinHash":  hash_pin(pin),
                "gmail":    gmail or None,
                "gmailVerified": not gmail,  # no Gmail → trivially "verified"
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            users.append(user)
            save_users(users)

        if gmail:
            send_email(
                to=gmail,
                subject="Welcome to the 1% Healthy Habit Circle",
                text=(
                    f"Hi {username},\n\n"
                    f"Welcome to the 1% Healthy Habit Circle.\n\n"
                    f"Your account is ready. You can sign in at:\n"
                    f"{FRONTEND_URL}\n\n"
                    f"Username: {username}\n\n"
                    f"If you ever forget your PIN, click \"Forgotten Password\" on the sign-in page "
                    f"and we'll send a 5-digit code to this Gmail address.\n\n"
                    f"— {MAIL_FROM_NAME}"
                ),
            )
        return _send(self, 201, {"ok": True, "username": user["username"]})

    def _signup_send_code(self):
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        pin      = str(body.get("pin")      or "").strip()
        gmail    = str(body.get("gmail")    or "").strip()

        if len(username) < 3:
            return _send(self, 400, {"error": "Username must be at least 3 characters."})
        if not PIN_RE.match(pin):
            return _send(self, 400, {"error": "Please, enter a six digit password."})
        if not EMAIL_RE.match(gmail):
            return _send(self, 400, {"error": "Enter a valid Gmail address."})

        # Throttle sign-up code-send (anti email-bombing).
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"signup:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _code_buckets, key, now_ms,
                _CODE_MAX_FAILS, _CODE_WINDOW_MS, _CODE_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        with _lock:
            users = load_users()
            if any((u.get("gmail") or "").lower() == gmail.lower() for u in users):
                return _send(self, 409, {"error": "An account with that Gmail already exists."})
            if any(u["username"].lower() == username.lower() for u in users):
                return _send(self, 409, {"error": "That username is taken. Try another."})

            pendings = load_pendings()
            pendings[username.lower()] = {
                "username": username,
                "pinHash":  hash_pin(pin),
                "gmail":    gmail,
                "createdAt": int(time.time() * 1000),
            }
            save_pendings(pendings)

        code = issue_code(username, "signup")
        send_email(
            to=gmail,
            subject="Your 1% Healthy Habit verification code",
            text=(
                f"Hi {username},\n\n"
                f"Your 5-digit verification code is:\n\n"
                f"    {code}\n\n"
                f"Enter this code in the open window to finish creating your account. "
                f"The code expires in 15 minutes.\n\n"
                f"— {MAIL_FROM_NAME}"
            ),
        )
        return _send(self, 200, {"ok": True})

    def _signin(self):
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        pin      = str(body.get("pin")      or "").strip()

        if len(username) < 3:
            return _send(self, 400, {"error": "Please enter a username."})
        if not PIN_RE.match(pin):
            return _send(self, 400, {"error": "Please, enter a six digit password."})

        # Throttle brute-force PIN guessing.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"user:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _login_buckets, key, now_ms,
                _LOGIN_MAX_FAILS, _LOGIN_WINDOW_MS, _LOGIN_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        with _lock:
            users = load_users()
            user = next((u for u in users if u["username"].lower() == username.lower()), None)
        if not user or not verify_pin(pin, user["pinHash"]):
            return _send(self, 401, {"error": "Wrong username or PIN."})
        # Successful auth: clear the per-username bucket.
        _rl_success(_login_buckets, f"user:{username.lower()}")
        return _send(self, 200, {
            "ok": True,
            "role": "student",
            "username": user["username"],
            "gmail": user.get("gmail"),
            "redirect": USER_LANDING,
        })

    def _teacher_signin(self):
        # Shared-secret teacher login. There is ONE teacher account.
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "").strip()

        if not TEACHER_USERNAME or not TEACHER_PASSWORD:
            return _send(self, 503, {"error": "Teacher sign-in is not configured on this server."})
        if not username or not password:
            return _send(self, 400, {"error": "Username and password are required."})

        # Throttle the (single) teacher account.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"teacher:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _login_buckets, key, now_ms,
                _LOGIN_MAX_FAILS, _LOGIN_WINDOW_MS, _LOGIN_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        # Constant-time compare to avoid leaking which field is wrong
        user_ok = hmac.compare_digest(username.encode("utf-8"), TEACHER_USERNAME.encode("utf-8"))
        pass_ok = hmac.compare_digest(password.encode("utf-8"), TEACHER_PASSWORD.encode("utf-8"))
        if not (user_ok and pass_ok):
            return _send(self, 401, {"error": "Wrong username or PIN."})

        _rl_success(_login_buckets, f"teacher:{username.lower()}")
        return _send(self, 200, {
            "ok": True,
            "role": "teacher",
            "redirect": TEACHER_LANDING,
        })

    def _list_students(self):
        # Public read-only listing of every account in users.json.
        # Used by the Teacher's gradebook to hydrate its student list.
        # Strips pinHash and gmail — we only ship the bits the gradebook
        # needs to display names and account creation times.
        with _lock:
            users = load_users()
        safe = [
            {k: u.get(k) for k in ("id", "username", "createdAt")}
            for u in users
        ]
        return _send(self, 200, {"ok": True, "students": safe})

    def _gradebook(self):
        # One-shot gradebook for the Teacher's page. Returns every
        # account with its full points snapshot so the client can render
        # the table AND classify (active vs ghost) without making N
        # round-trips and without trusting the client's local cache.
        # The client cache was the source of "Student page says 20,
        # Teacher page says 0" — that mismatch came from the teacher
        # never re-reading scores from the server.
        with _lock:
            users = load_users()
        rows = []
        for u in users:
            row = {
                "id":            u.get("id"),
                "username":      u.get("username"),
                "createdAt":     u.get("createdAt"),
                "score":         int(u.get("score") or 0),
                "awardCount":    int(u.get("awardCount") or 0),
                "lastAwardedAt": u.get("lastAwardedAt"),
                "history":       u.get("history") or [],
            }
            rows.append(row)
        return _send(self, 200, {"ok": True, "students": rows})

    def _delete_student(self):
        # Hard-delete a student account, gated by the shared teacher
        # password (same secret as /api/teacher-signin). Used by the
        # Teacher's gradebook trash button so a deleted student can no
        # longer sign in.
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        password = str(body.get("teacherPassword") or "").strip()

        if not TEACHER_USERNAME or not TEACHER_PASSWORD:
            return _send(self, 503, {"error": "Teacher sign-in is not configured on this server."})
        if not username or not password:
            return _send(self, 400, {"error": "Username and teacher password are required."})

        # Throttle the (single) teacher account, same as _teacher_signin.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"teacher:{TEACHER_USERNAME.lower()}", ip_key):
            locked, retry = _rl_consume(
                _login_buckets, key, now_ms,
                _LOGIN_MAX_FAILS, _LOGIN_WINDOW_MS, _LOGIN_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        # Constant-time compare on the teacher password.
        pass_ok = hmac.compare_digest(password.encode("utf-8"), TEACHER_PASSWORD.encode("utf-8"))
        if not pass_ok:
            return _send(self, 401, {"error": "Wrong username or PIN."})

        with _lock:
            users = load_users()
            target = next((u for u in users if u["username"].lower() == username.lower()), None)
            if not target:
                return _send(self, 404, {"error": "No account with that username."})
            # Refuse to delete the teacher account itself, so a stray
            # delete never locks the teacher out.
            if target["username"].lower() == TEACHER_USERNAME.lower():
                return _send(self, 400, {"error": "Cannot delete the teacher account."})
            users = [u for u in users if u["username"].lower() != username.lower()]
            save_users(users)

        _rl_success(_login_buckets, f"teacher:{TEACHER_USERNAME.lower()}")
        return _send(self, 200, {"ok": True, "username": target["username"]})

    # ---------- shared-secret teacher check (for write paths) ----------
    def _require_teacher(self, password: str):
        """Validate the shared teacher password. Returns an error
        response tuple (status, body) on failure, or None on success.
        Rate-limited per-teacher-username only — NOT per-IP — because
        the write endpoints (PUT /api/challenge, PUT /api/students/.../points)
        are only ever called by the logged-in teacher, and a per-IP
        gate would lock the teacher out the moment they award a few
        students in quick succession. The per-IP gate stays on
        /api/teacher-signin where it's still useful (an attacker who
        doesn't know the username either)."""
        password = str(password or "").strip()
        if not TEACHER_USERNAME or not TEACHER_PASSWORD:
            return 503, {"error": "Teacher sign-in is not configured on this server."}
        if not password:
            return 400, {"error": "Teacher password is required."}

        now_ms = _rl_now()
        teacher_key = f"teacher:{TEACHER_USERNAME.lower()}"
        locked, retry = _rl_consume(
            _login_buckets, teacher_key, now_ms,
            _LOGIN_MAX_FAILS, _LOGIN_WINDOW_MS, _LOGIN_LOCKOUT_MS,
        )
        if locked:
            return 429, _rl_locked_response(retry)

        if not hmac.compare_digest(password.encode("utf-8"), TEACHER_PASSWORD.encode("utf-8")):
            return 401, {"error": "Wrong username or PIN."}

        _rl_success(_login_buckets, teacher_key)
        return None

    # ---------- challenge (today's text + per-student mark-done) ----------
    def _get_challenge(self):
        # Public read. The challenge is live if EITHER:
        #   - the new expiresAt ms-timestamp is in the future, OR
        #   - the legacy `date` key matches today's local day.
        # The first condition handles the new custom-expiry challenges
        # (which can live across midnight and have an arbitrary
        # `date` of the day they were posted). The second is the
        # legacy day-roll that pre-dates the content system.
        today = _today_key()
        with _lock:
            row = load_challenge()
        if not isinstance(row, dict):
            row = {}
        text = str(row.get("text") or "").strip()
        if not text:
            return _send(self, 200, {"ok": True, "date": today, "text": ""})
        exp = row.get("expiresAt")
        if isinstance(exp, int) and exp > 0:
            if _rl_now() >= exp:
                # Expired — return empty so the Student page shows the
                # "no challenge today" state. The sweep in /api/content
                # has already moved the row to the archive, but this
                # legacy path doesn't go through the sweep.
                return _send(self, 200, {"ok": True, "date": today, "text": ""})
            return _send(self, 200, {
                "ok": True,
                "date": str(row.get("date") or today),
                "text": text,
                "expiresAt": exp,
            })
        # Legacy day-roll.
        if row.get("date") != today:
            return _send(self, 200, {"ok": True, "date": today, "text": ""})
        return _send(self, 200, {"ok": True, "date": today, "text": text})

    def _put_challenge(self):
        # Teacher-only write. Body is { text, teacherPassword }.
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        err = self._require_teacher(body.get("teacherPassword"))
        if err is not None:
            return _send(self, err[0], err[1])

        text = str(body.get("text") or "").strip()
        if not text:
            return _send(self, 400, {"error": "Type a challenge first."})
        # Cap length so a teacher can't accidentally paste a wall of text.
        text = text[:280]

        today = _today_key()
        now_ms = _rl_now()
        with _lock:
            save_challenge({
                "date": today,
                "text": text,
                "setAt": now_ms,
                "setBy": TEACHER_USERNAME,
            })
            # New challenge, fresh slate. The teacher just changed the
            # prompt — any "done" rows are for the old prompt, so drop
            # every one. This covers both "different day" (rows from
            # yesterday) and "same day, different text" (rows from
            # the previous prompt the student already finished).
            save_challenge_done({})

        return _send(self, 200, {"ok": True, "date": today, "text": text})

    def _get_challenge_done(self):
        # /api/challenge/done?username=X
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
        except Exception:
            qs = {}
        raw_username = (qs.get("username") or [""])[0]
        username = str(raw_username).strip().lower()
        if not username:
            return _send(self, 400, {"error": "username query parameter is required."})

        today = _today_key()
        with _lock:
            done = load_challenge_done()
        if not isinstance(done, dict):
            done = {}
        row = done.get(username)
        if not isinstance(row, dict) or row.get("date") != today:
            return _send(self, 200, {"ok": True, "username": username, "done": False, "doneAt": None})
        return _send(self, 200, {
            "ok": True,
            "username": username,
            "done": bool(row.get("done")),
            "doneAt": row.get("doneAt"),
        })

    def _post_challenge_done(self):
        # Public write, but scoped to the named user. The body is
        # { username, mark }. We 404 if the username doesn't exist so a
        # client can't poll arbitrary names silently; we 409 if today's
        # challenge is empty so a "mark done" of nothing never sticks.
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        username = str(body.get("username") or "").strip().lower()
        if not username:
            return _send(self, 400, {"error": "username is required."})
        if "mark" not in body:
            return _send(self, 400, {"error": "mark is required (true or false)."})
        mark = bool(body.get("mark"))

        today = _today_key()
        with _lock:
            users = load_users()
            user = next((u for u in users if u["username"].lower() == username), None)
            if not user:
                return _send(self, 404, {"error": "No account with that username."})
            challenge = load_challenge()
            if not isinstance(challenge, dict) or challenge.get("date") != today or not str(challenge.get("text") or "").strip():
                return _send(self, 409, {"error": "No challenge set for today."})

            done = load_challenge_done()
            if not isinstance(done, dict):
                done = {}

            # Prune anything older than 7 days as we go, so the file
            # doesn't grow without bound over a school year. The
            # comparison is on calendar dates (YYYY-MM-DD) so we
            # don't accidentally mix seconds vs milliseconds in the
            # cutoff math (which would silently delete every row).
            cutoff_calendar_ms = _rl_now() - 7 * 24 * 60 * 60 * 1000
            cutoff_calendar_day = time.strftime(
                "%Y-%m-%d", time.localtime(cutoff_calendar_ms / 1000)
            )
            pruned = {}
            for k, v in done.items():
                if not isinstance(v, dict):
                    continue
                d = str(v.get("date") or "")
                if not d:
                    continue
                # String compare works because YYYY-MM-DD sorts as
                # chronological order, and the cutoff is a date too.
                if d >= cutoff_calendar_day:
                    pruned[k] = v
            done = pruned

            if mark:
                now_ms = _rl_now()
                done[username] = {"date": today, "done": True, "doneAt": now_ms}
                save_challenge_done(done)
                return _send(self, 200, {"ok": True, "username": username, "done": True, "doneAt": now_ms})
            else:
                # mark=false means reset for today
                if username in done and done[username].get("date") == today:
                    del done[username]
                save_challenge_done(done)
                return _send(self, 200, {"ok": True, "username": username, "done": False, "doneAt": None})

    # ---------- student-driven username change ----------
    def _rename_username(self):
        # Student re-auths with their PIN to rename their own account.
        # The teacher can no longer rename a student from the gradebook
        # (that was a footgun: the teacher's local copy was the only
        # thing that changed, and the server row kept the old name, so
        # the student either disappeared or duplicated on next sync).
        # Now the rename is server-side, and points/history travel with
        # the row because they live on the same object in users.json.
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        old_username = str(body.get("oldUsername") or "").strip()
        new_username = str(body.get("newUsername") or "").strip()
        pin          = str(body.get("pin")         or "").strip()

        if len(old_username) < 3:
            return _send(self, 400, {"error": "oldUsername is required."})
        if len(new_username) < 3:
            return _send(self, 400, {"error": "New username must be at least 3 characters."})
        if new_username.lower() == old_username.lower():
            return _send(self, 400, {"error": "That's already your username."})
        if not PIN_RE.match(pin):
            return _send(self, 400, {"error": "Please, enter a six digit password."})

        # Throttle the same way as /api/signin: per-username AND per-IP,
        # 5 attempts / 60s / 5-min lockout. The PIN is the same secret,
        # so the threat model is identical.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"rename:{old_username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _login_buckets, key, now_ms,
                _LOGIN_MAX_FAILS, _LOGIN_WINDOW_MS, _LOGIN_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        with _lock:
            users = load_users()
            user = next((u for u in users if u["username"].lower() == old_username.lower()), None)
            if not user:
                return _send(self, 401, {"error": "Wrong username or PIN."})
            if not verify_pin(pin, user.get("pinHash") or ""):
                return _send(self, 401, {"error": "Wrong username or PIN."})
            # Check that no OTHER user has already taken the new name.
            clash = next(
                (u for u in users
                 if u is not user and u["username"].lower() == new_username.lower()),
                None,
            )
            if clash:
                return _send(self, 409, {"error": "That username is taken. Try another."})
            # Refuse to rename onto the shared teacher account, so a
            # student can't squat on the teacher's name.
            if TEACHER_USERNAME and new_username.lower() == TEACHER_USERNAME.lower():
                return _send(self, 409, {"error": "That username is reserved."})
            # Refuse to rename the teacher account itself, so this path
            # never collides with the teacher-signin flow.
            if TEACHER_USERNAME and user["username"].lower() == TEACHER_USERNAME.lower():
                return _send(self, 400, {"error": "This account can't be renamed from here."})

            # All checks passed — apply the rename. Points/history live
            # on the same row, so they move with the username.
            old_lower = user["username"].lower()
            user["username"] = new_username
            user["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            save_users(users)

            # The .challenge-done.json file is keyed by lowercased
            # username. Move the row across so today's "done" marker
            # follows the rename. We also prune anything from a previous
            # day so the file doesn't accumulate stale entries.
            done = load_challenge_done()
            if not isinstance(done, dict):
                done = {}
            today = _today_key()
            if old_lower in done and isinstance(done[old_lower], dict) and done[old_lower].get("date") == today:
                new_lower = new_username.lower()
                done[new_lower] = done.pop(old_lower)
            save_challenge_done(done)

        _rl_success(_login_buckets, f"rename:{old_username.lower()}")
        return _send(self, 200, {"ok": True, "username": new_username})

    # ---------- content (challenges + notifications + archive) ----------
    # The "content" system is the unified replacement for the old inline
    # challenge editor. Three kinds of items can be live at once:
    #   - daily-challenge (24h, replaces the legacy `_get_challenge` flow)
    #   - new-challenge (custom expiry ms-timestamp)
    #   - notification (auto-archive when every student has viewed it)
    # All three are returned by GET /api/content and live alongside each
    # other in the active list. The legacy GET /api/challenge +
    # /api/challenge/done paths still work — they're a thin wrapper that
    # reads the same storage.
    #
    # Storage:
    #   .challenge.json  — {date, text, setAt, setBy, expiresAt, kind}
    #                     (legacy rows may lack expiresAt — backfill on read)
    #   .notifications.json — [{id, title, body, createdAt, viewedBy, ...}]
    #   .archive.json       — [{id, kind, title?, text?, body?, createdAt,
    #                          expiresAt, archivedAt, archiveReason, viewedBy}]
    #
    # A view is recorded server-side: a student GET with ?username=X
    # adds X to every active notification's `viewedBy` set. Once
    # viewedBy covers every currently-enrolled user, the notification
    # moves to .archive.json with archiveReason="all-viewed".

    def _enrolled_usernames(self):
        """Return the set of lowercased usernames currently enrolled.
        Computed fresh on every call so a recently-signed-up student is
        included immediately, and a recently-deleted student no longer
        counts toward the "everyone has viewed" total."""
        with _lock:
            users = load_users()
        out = set()
        for u in users:
            name = str(u.get("username") or "").strip().lower()
            if name:
                out.add(name)
        return out

    def _total_enrolled(self):
        return len(self._enrolled_usernames())

    def _sweep_archives_locked(self):
        """Run the auto-archive sweep while holding _lock. Idempotent —
        safe to call on every read.
        Moves an active challenge to archive if its expiresAt has passed,
        and an active notification to archive if viewedBy now covers
        every enrolled username.
        """
        now_ms = _rl_now()
        enrolled = set()
        with _lock:
            users = load_users()
            for u in users:
                name = str(u.get("username") or "").strip().lower()
                if name:
                    enrolled.add(name)

            # 1. Challenges
            challenge = load_challenge()
            if isinstance(challenge, dict) and challenge:
                exp = challenge.get("expiresAt")
                if isinstance(exp, int) and exp > 0 and now_ms >= exp:
                    archive_row = {
                        "id": challenge.get("id") or "challenge-legacy",
                        "kind": str(challenge.get("kind") or "daily-challenge"),
                        "text": str(challenge.get("text") or ""),
                        "createdAt": challenge.get("setAt") or now_ms,
                        "expiresAt": exp,
                        "archivedAt": now_ms,
                        "archiveReason": "expired",
                        "setBy": challenge.get("setBy"),
                        "setAt": challenge.get("setAt"),
                    }
                    archive = load_archive()
                    archive.append(archive_row)
                    # Cap archive to the last 200 rows so the file doesn't
                    # grow without bound over a school year.
                    if len(archive) > 200:
                        archive = archive[-200:]
                    save_archive(archive)
                    # The challenge is now "expired" — clear the active slot
                    # so the next /api/content GET doesn't return it.
                    save_challenge({})
                    challenge = {}

            # 2. Notifications
            notifs = load_notifications()
            if not isinstance(notifs, list):
                notifs = []
            kept = []
            archive = load_archive()
            for n in notifs:
                if not isinstance(n, dict):
                    continue
                if n.get("archived"):
                    kept.append(n)  # shouldn't happen, but harmless
                    continue
                viewed = set(str(x).lower() for x in (n.get("viewedBy") or []))
                if enrolled and viewed and enrolled.issubset(viewed):
                    # Everyone has seen it — move to archive.
                    archive_row = {
                        "id": n.get("id"),
                        "kind": "notification",
                        "title": n.get("title"),
                        "body": n.get("body"),
                        "createdAt": n.get("createdAt"),
                        "expiresAt": None,
                        "archivedAt": now_ms,
                        "archiveReason": "all-viewed",
                        "viewedBy": list(viewed),
                    }
                    archive.append(archive_row)
                else:
                    kept.append(n)
            if len(archive) > 200:
                archive = archive[-200:]
            save_archive(archive)
            save_notifications(kept)
            return challenge, kept, archive

    def _enrich_challenge_row(self, challenge, done):
        """Build the public active-list row for the current challenge.
        `done` is the .challenge-done.json dict (may be {}). Returns
        a row dict or None if there's nothing to show."""
        if not isinstance(challenge, dict) or not challenge:
            return None
        text = str(challenge.get("text") or "").strip()
        if not text:
            return None
        now_ms = _rl_now()
        exp = challenge.get("expiresAt")
        # If the row is expired, return None so the caller doesn't show it.
        if isinstance(exp, int) and exp > 0 and now_ms >= exp:
            return None
        kind = str(challenge.get("kind") or "daily-challenge")
        # Compute doneCount/totalStudents for the current day so the
        # teacher sees at a glance how many students finished.
        today = _today_key()
        total = self._total_enrolled()
        done_count = 0
        for k, v in (done or {}).items():
            if not isinstance(v, dict):
                continue
            if v.get("date") == today and v.get("done"):
                done_count += 1
        # Return type is optional. Legacy challenges predate the
        # return-type field; the client treats a missing/None returnType
        # as the legacy "mark done" flow. Validate against the allowed
        # set on the way out so a corrupted store can't slip through.
        rt = challenge.get("returnType")
        if rt not in ("text", "image", "video", "audio", None):
            rt = None
        return {
            "id":            str(challenge.get("id") or "challenge-current"),
            "kind":          kind,
            "title":         "Today's challenge" if kind == "daily-challenge" else "Challenge",
            "text":          text,
            "setAt":         challenge.get("setAt"),
            "setBy":         challenge.get("setBy"),
            "expiresAt":     exp,
            "createdAt":     challenge.get("setAt") or now_ms,
            "doneCount":     done_count,
            "totalStudents": total,
            "viewedBy":      None,  # challenges don't use viewedBy
            "returnType":    rt,
        }

    def _enrich_notification_row(self, n):
        if not isinstance(n, dict):
            return None
        now_ms = _rl_now()
        return {
            "id":            n.get("id"),
            "kind":          "notification",
            "title":         str(n.get("title") or "").strip(),
            "body":          str(n.get("body") or "").strip(),
            "createdAt":     n.get("createdAt") or now_ms,
            "expiresAt":     None,
            "viewedBy":      list(n.get("viewedBy") or []),
            "totalStudents": self._total_enrolled(),
        }

    def _enrich_message_row(self, m):
        """Build the public active-list row for a teacher-sent message.
        Messages don't auto-archive, don't track per-student views, and
        always accept replies (text + audio). The reply count is
        computed inline so the teacher sees a 'N replies' pill on the
        active-list row without an extra round-trip."""
        if not isinstance(m, dict):
            return None
        if m.get("archived"):
            return None
        title = str(m.get("title") or "").strip()
        body  = str(m.get("body") or "").strip()
        if not title and not body:
            return None
        now_ms = _rl_now()
        msg_id = str(m.get("id") or "")
        # Cheap reply count. We scan .replies.json each call — it's
        # bounded (replies per parent) and the file is small in
        # practice. If it ever grows large we can keep a counter on
        # the message row itself.
        reply_count = 0
        try:
            replies = load_replies()
            if isinstance(replies, list):
                reply_count = sum(
                    1 for r in replies
                    if isinstance(r, dict)
                    and str(r.get("parentId") or "") == msg_id
                )
        except Exception:
            reply_count = 0
        return {
            "id":           msg_id,
            "kind":         "message",
            "title":        title,
            "body":         body,
            "createdAt":    m.get("createdAt") or now_ms,
            "expiresAt":    None,
            "viewedBy":     None,           # messages don't track views
            "returnType":   None,           # messages always allow text+audio
            "replyCount":   reply_count,
        }

    def _get_content(self):
        """GET /api/content?username=X
        Returns {ok, active, archive, studentArchive?, now}. If username
        is supplied, records a view for that username against every
        active notification (idempotent — re-views are no-ops). If the
        `?role=teacher` query is set, no view is recorded (lets the
        teacher preview the feed without poisoning the read counters).
        The `studentArchive` field is only included when a username is
        supplied and the role is not "teacher" — it contains that
        student's personal archive of notifications they viewed and
        then signed out from."""
        # Rate-limit per IP. 60 reads / 60s comfortably accommodates the
        # Student page's 20-second poll (3 reads/min/tab) and the
        # teacher's 30-second poll. Per-IP keeps a runaway client from
        # spiking the file system.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        locked, retry = _rl_consume(
            _content_view_buckets, ip_key, now_ms,
            60, 60 * 1000, 60 * 1000,
        )
        if locked:
            return _send(self, 429, _rl_locked_response(retry))

        # Parse query.
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
        except Exception:
            qs = {}
        username = (qs.get("username") or [""])[0].strip().lower()
        role = (qs.get("role") or [""])[0].strip().lower()

        # Sweep archives (under lock) and grab a fresh copy of all three
        # stores. Doing it here means the active/archive lists are
        # always self-consistent — a teacher who posts a notification
        # and then refreshes sees the right thing in the archive drawer
        # without a second round-trip.
        challenge, notifs, archive = self._sweep_archives_locked()

        # Record the view if this is a student GET.
        if username and role != "teacher":
            with _lock:
                # Verify the user actually exists; ignore otherwise
                # (we don't want random ?username= probes to add junk
                # to the viewedBy set).
                users = load_users()
                if any(u.get("username", "").lower() == username for u in users):
                    updated = False
                    for n in notifs:
                        if not isinstance(n, dict):
                            continue
                        viewed = list(n.get("viewedBy") or [])
                        if username not in [v.lower() for v in viewed]:
                            viewed.append(username)
                            n["viewedBy"] = viewed
                            updated = True
                    if updated:
                        save_notifications(notifs)
                        # Re-sweep: this view may have completed the set.
                        challenge, notifs, archive = self._sweep_archives_locked()

        # Build the public response.
        done = load_challenge_done()
        if not isinstance(done, dict):
            done = {}
        active = []
        ch_row = self._enrich_challenge_row(challenge, done)
        if ch_row:
            active.append(ch_row)
        for n in notifs:
            r = self._enrich_notification_row(n)
            if r:
                active.append(r)
        # Fold in messages. Messages don't auto-archive, don't track
        # per-student views, and are shown alongside notifications.
        # They're read directly from the store (no sweep needed) so a
        # freshly-posted message appears in the same response.
        try:
            messages = load_messages()
        except Exception:
            messages = []
        if isinstance(messages, list):
            for m in messages:
                r = self._enrich_message_row(m)
                if r:
                    active.append(r)

        # Sort: notifications + messages first (newest first), then the
        # challenge. (The challenge itself stays at the bottom; the
        # existing "Today's Challenge" card on the student page is
        # unaffected.)
        def _sort_key(r):
            kind = r.get("kind")
            kind_order = 1 if kind in ("daily-challenge", "new-challenge") else 0
            ts = r.get("createdAt") or 0
            return (kind_order, -ts)
        active.sort(key=_sort_key)

        # Archive list — newest first, capped to last 100 rows in the
        # response so the drawer renders quickly even after a long
        # school year.
        archive_sorted = sorted(
            [a for a in archive if isinstance(a, dict)],
            key=lambda a: a.get("archivedAt") or 0,
            reverse=True,
        )[:100]

        # The "viewedByMe" hint for the student side: which archive
        # notifications were viewed by this user. We don't strictly
        # need this client-side (notifications are archived only when
        # everyone viewed them, so by definition the current student
        # viewed all of them) but it's cheap to ship and useful for
        # the "you haven't seen this yet" case if we ever change the
        # auto-archive rule.
        if username:
            for a in archive_sorted:
                viewed = set(str(x).lower() for x in (a.get("viewedBy") or []))
                a["viewedByMe"] = username in viewed

        response = {
            "ok": True,
            "active": active,
            "archive": archive_sorted,
            "now": now_ms,
        }

        # Per-student archive: only sent for student GETs. The teacher
        # has no "personal" archive — the global one IS the teacher's
        # archive. Filter by username, newest first, capped to 100.
        if username and role != "teacher":
            try:
                sa = load_student_archive()
            except Exception:
                sa = []
            sa_rows = [
                r for r in (sa if isinstance(sa, list) else [])
                if isinstance(r, dict)
                and str(r.get("studentUsername") or "").strip().lower() == username
            ]
            sa_rows.sort(
                key=lambda r: r.get("archivedAt") or r.get("createdAt") or 0,
                reverse=True,
            )
            response["studentArchive"] = sa_rows[:100]

        return _send(self, 200, response)

    def _post_content(self):
        """POST /api/content  — teacher creates a new piece of content.
        Body: { kind, text?, title?, body?, expiresAt?, returnType?, teacherPassword }
        `kind` ∈ {daily-challenge, new-challenge, notification, message}.
        `returnType` is only meaningful for challenges and is one of
        {text, image, video, audio} or null (legacy mark-done flow).
        """
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        err = self._require_teacher(body.get("teacherPassword"))
        if err is not None:
            return _send(self, err[0], err[1])

        # Per-teacher post rate-limit. 10 posts / 5 min keeps a
        # misclick from spamming the active list and lets the
        # notification auto-archive work.
        now_ms = _rl_now()
        teacher_key = f"teacher-post:{TEACHER_USERNAME.lower()}"
        locked, retry = _rl_consume(
            _content_post_buckets, teacher_key, now_ms,
            10, 5 * 60 * 1000, 5 * 60 * 1000,
        )
        if locked:
            return _send(self, 429, _rl_locked_response(retry))

        kind = str(body.get("kind") or "").strip().lower()
        if kind not in ("daily-challenge", "new-challenge", "notification", "message"):
            return _send(self, 400, {"error": "Unknown content kind."})

        with _lock:
            if kind in ("daily-challenge", "new-challenge"):
                text = str(body.get("text") or "").strip()
                if not text:
                    return _send(self, 400, {"error": "Type a challenge first."})
                text = text[:280]

                if kind == "new-challenge":
                    # Custom expiry. Must be a positive integer ms
                    # timestamp in the future (and not absurdly far out).
                    raw_exp = body.get("expiresAt")
                    try:
                        exp = int(raw_exp)
                    except Exception:
                        return _send(self, 400, {"error": "Pick an expiry date and time."})
                    if exp <= now_ms + 60 * 1000:
                        return _send(self, 400, {"error": "Expiry must be at least a minute in the future."})
                    if exp > now_ms + 30 * 24 * 60 * 60 * 1000:
                        return _send(self, 400, {"error": "Expiry can't be more than 30 days out."})
                else:
                    # Daily: expires at local midnight tomorrow.
                    t = time.localtime(now_ms / 1000)
                    tomorrow = time.mktime((t.tm_year, t.tm_mon, t.tm_mday + 1, 0, 0, 0, 0, 0, 0))
                    exp = int(tomorrow * 1000)

                # If a challenge of the OTHER kind is currently live,
                # archive it before posting the new one. The active
                # list shows at most one of each kind; mixing them is
                # confusing and the user explicitly asked for "either
                # a daily challenge OR a custom one".
                prev = load_challenge()
                if isinstance(prev, dict) and prev:
                    prev_kind = str(prev.get("kind") or "daily-challenge")
                    if prev_kind != kind:
                        archive = load_archive()
                        archive.append({
                            "id": prev.get("id") or "challenge-prev",
                            "kind": prev_kind,
                            "text": str(prev.get("text") or ""),
                            "createdAt": prev.get("setAt") or now_ms,
                            "expiresAt": prev.get("expiresAt"),
                            "archivedAt": now_ms,
                            "archiveReason": "replaced",
                            "setBy": prev.get("setBy"),
                            "setAt": prev.get("setAt"),
                        })
                        if len(archive) > 200:
                            archive = archive[-200:]
                        save_archive(archive)

                # Return type is optional. Default to None for legacy
                # mark-done challenges. Validate against the allowed
                # set so a typo from the client doesn't pollute the
                # store. The client side should always send a value;
                # missing/None keeps the legacy flow working.
                rt = body.get("returnType")
                if rt in ("", "null"):
                    rt = None
                if rt is not None and rt not in ("text", "image", "video", "audio"):
                    return _send(self, 400, {"error": "Invalid return type."})

                new_id = "ch-" + secrets.token_hex(6)
                save_challenge({
                    "id": new_id,
                    "kind": kind,
                    "text": text,
                    "setAt": now_ms,
                    "setBy": TEACHER_USERNAME,
                    "expiresAt": exp,
                    "returnType": rt,
                })
                # New prompt — clear all done markers (per-day on the
                # legacy flow; we'll keep that contract so the Student
                # page's `mark done` still works).
                save_challenge_done({})
                return _send(self, 200, {
                    "ok": True,
                    "id": new_id,
                    "kind": kind,
                    "expiresAt": exp,
                    "returnType": rt,
                })

            if kind == "message":
                # Teacher-sent message. Students can reply with text +
                # audio. No auto-archive, no per-student view tracking.
                title = str(body.get("title") or "").strip()
                body_text = str(body.get("body") or "").strip()
                if not title:
                    return _send(self, 400, {"error": "Add a title."})
                if len(title) > 80:
                    return _send(self, 400, {"error": "Title is too long (80 characters max)."})
                if not body_text:
                    return _send(self, 400, {"error": "Write a message."})
                if len(body_text) > 500:
                    return _send(self, 400, {"error": "Message is too long (500 characters max)."})

                new_id = "msg-" + secrets.token_hex(6)
                messages = load_messages()
                if not isinstance(messages, list):
                    messages = []
                messages.append({
                    "id": new_id,
                    "title": title,
                    "body": body_text,
                    "createdAt": now_ms,
                    "archived": False,
                    "archivedAt": None,
                })
                # Same cap as notifications — keeps the active list
                # bounded even after a long school year.
                if len(messages) > 50:
                    messages = messages[-50:]
                save_messages(messages)
                return _send(self, 200, {
                    "ok": True,
                    "id": new_id,
                    "kind": "message",
                    "createdAt": now_ms,
                })

            # notification
            title = str(body.get("title") or "").strip()
            body_text = str(body.get("body") or "").strip()
            if not title:
                return _send(self, 400, {"error": "Add a title."})
            if len(title) > 80:
                return _send(self, 400, {"error": "Title is too long (80 characters max)."})
            if not body_text:
                return _send(self, 400, {"error": "Write a message."})
            if len(body_text) > 500:
                return _send(self, 400, {"error": "Message is too long (500 characters max)."})

            new_id = "notif-" + secrets.token_hex(6)
            notif = {
                "id": new_id,
                "title": title,
                "body": body_text,
                "createdAt": now_ms,
                "viewedBy": [],
                "archived": False,
                "archivedAt": None,
            }
            notifs = load_notifications()
            if not isinstance(notifs, list):
                notifs = []
            notifs.append(notif)
            # Cap to a reasonable number of live notifications so a
            # teacher can never accidentally spam the active list.
            if len(notifs) > 25:
                notifs = notifs[-25:]
            save_notifications(notifs)
            return _send(self, 200, {
                "ok": True,
                "id": new_id,
                "kind": "notification",
                "createdAt": now_ms,
            })

    def _post_content_archive(self, content_id: str):
        """POST /api/content/<id>/archive  — teacher manually archives.
        Handles challenges, notifications, AND messages. Messages are
        soft-archived (kept in .messages.json with archived=true) so
        the teacher can re-activate them later if desired — but in
        practice we also push a copy to the global archive for
        consistency with the other content kinds."""
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        err = self._require_teacher(body.get("teacherPassword"))
        if err is not None:
            return _send(self, err[0], err[1])

        now_ms = _rl_now()
        with _lock:
            # Try the challenge slot first.
            challenge = load_challenge()
            if isinstance(challenge, dict) and str(challenge.get("id") or "") == content_id:
                archive = load_archive()
                archive.append({
                    "id": challenge.get("id"),
                    "kind": str(challenge.get("kind") or "daily-challenge"),
                    "text": str(challenge.get("text") or ""),
                    "createdAt": challenge.get("setAt") or now_ms,
                    "expiresAt": challenge.get("expiresAt"),
                    "archivedAt": now_ms,
                    "archiveReason": "manual",
                    "setBy": challenge.get("setBy"),
                    "setAt": challenge.get("setAt"),
                })
                if len(archive) > 200:
                    archive = archive[-200:]
                save_archive(archive)
                save_challenge({})
                save_challenge_done({})
                return _send(self, 200, {"ok": True, "id": content_id})

            # Then messages. Soft-archive (mark archived=true) so the
            # message disappears from the active list, and also push a
            # copy to the global archive for parity with the other
            # content kinds.
            try:
                messages = load_messages()
            except Exception:
                messages = []
            if isinstance(messages, list):
                kept = []
                archived_row = None
                for m in messages:
                    if not isinstance(m, dict):
                        continue
                    if str(m.get("id") or "") == content_id and archived_row is None:
                        archived_row = {
                            "id": m.get("id"),
                            "kind": "message",
                            "title": m.get("title"),
                            "body": m.get("body"),
                            "createdAt": m.get("createdAt"),
                            "expiresAt": None,
                            "archivedAt": now_ms,
                            "archiveReason": "manual",
                        }
                        # Soft-archive: replace the row with the
                        # archived flag set so the active-list
                        # _enrich_message_row filters it out.
                        m = dict(m)
                        m["archived"] = True
                        m["archivedAt"] = now_ms
                    kept.append(m)
                if archived_row is not None:
                    archive = load_archive()
                    archive.append(archived_row)
                    if len(archive) > 200:
                        archive = archive[-200:]
                    save_archive(archive)
                    save_messages(kept)
                    return _send(self, 200, {"ok": True, "id": content_id})

            # Then notifications.
            notifs = load_notifications()
            if not isinstance(notifs, list):
                notifs = []
            kept = []
            archived_row = None
            for n in notifs:
                if not isinstance(n, dict):
                    continue
                if str(n.get("id") or "") == content_id and archived_row is None:
                    archived_row = {
                        "id": n.get("id"),
                        "kind": "notification",
                        "title": n.get("title"),
                        "body": n.get("body"),
                        "createdAt": n.get("createdAt"),
                        "expiresAt": None,
                        "archivedAt": now_ms,
                        "archiveReason": "manual",
                        "viewedBy": list(n.get("viewedBy") or []),
                    }
                else:
                    kept.append(n)
            if archived_row is not None:
                archive = load_archive()
                archive.append(archived_row)
                if len(archive) > 200:
                    archive = archive[-200:]
                save_archive(archive)
                save_notifications(kept)
                return _send(self, 200, {"ok": True, "id": content_id})

        return _send(self, 404, {"error": "No content with that id."})

    # ---------- per-student points (mirror of teacher's localStorage) ----------
    def _get_student_points(self, username_lower: str):
        with _lock:
            users = load_users()
        user = next((u for u in users if u["username"].lower() == username_lower), None)
        if not user:
            return _send(self, 404, {"error": "No account with that username."})
        return _send(self, 200, {
            "ok": True,
            "username": user["username"],
            "score":     int(user.get("score") or 0),
            "awardCount": int(user.get("awardCount") or 0),
            "lastAwardedAt": user.get("lastAwardedAt"),
            "history":   user.get("history") or [],
        })

    def _put_student_points(self, username_lower: str):
        # Teacher-only write. The teacher awards points on their own
        # gradebook; we mirror the resulting {score, awardCount,
        # lastAwardedAt, history} to the server so the student page
        # (and any future cross-device view) sees the same numbers.
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        err = self._require_teacher(body.get("teacherPassword"))
        if err is not None:
            return _send(self, err[0], err[1])

        # Read & sanitize the four fields. We don't trust the client
        # with types — coerce everything to int / list / int-or-null.
        try:
            score = int(body.get("score") or 0)
        except Exception:
            return _send(self, 400, {"error": "score must be a non-negative integer."})
        if score < 0:
            score = 0
        try:
            award_count = int(body.get("awardCount") or 0)
        except Exception:
            return _send(self, 400, {"error": "awardCount must be a non-negative integer."})
        if award_count < 0:
            award_count = 0
        last_awarded_at = body.get("lastAwardedAt")
        if last_awarded_at is not None:
            try:
                last_awarded_at = int(last_awarded_at)
            except Exception:
                return _send(self, 400, {"error": "lastAwardedAt must be a millisecond timestamp or null."})
        history_in = body.get("history")
        if not isinstance(history_in, list):
            return _send(self, 400, {"error": "history must be a list of {at, delta} entries."})
        clean_history = []
        for ev in history_in[-500:]:  # cap to the last 500 to keep the file small
            if not isinstance(ev, dict):
                continue
            try:
                at = int(ev.get("at"))
                delta = int(ev.get("delta"))
            except Exception:
                continue
            clean_history.append({"at": at, "delta": delta})

        with _lock:
            users = load_users()
            target = next((u for u in users if u["username"].lower() == username_lower), None)
            if not target:
                return _send(self, 404, {"error": "No account with that username."})
            target["score"] = score
            target["awardCount"] = award_count
            target["lastAwardedAt"] = last_awarded_at
            target["history"] = clean_history
            save_users(users)

        return _send(self, 200, {"ok": True, "username": target["username"]})

    def _forgot(self):
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        if len(username) < 3:
            return _send(self, 400, {"error": "Please enter your username."})

        # Throttle username enumeration + email flooding.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"forgot:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _code_buckets, key, now_ms,
                _CODE_MAX_FAILS, _CODE_WINDOW_MS, _CODE_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        with _lock:
            users = load_users()
            user = next((u for u in users if u["username"].lower() == username.lower()), None)
        if not user:
            return _send(self, 404, {"error": "The username you entered doesn't exist."})

        if not user.get("gmail"):
            return _send(self, 200, {"ok": True, "reason": "no-gmail"})

        code = issue_code(user["username"], "forgot")
        send_email(
            to=user["gmail"],
            subject="Your 1% Healthy Habit reset code",
            text=(
                f"Hi {user['username']},\n\n"
                f"Your 5-digit PIN-reset code is:\n\n"
                f"    {code}\n\n"
                f"Open the sign-in page in your browser, then enter this code in the popup "
                f"to choose a new PIN. The code expires in 15 minutes.\n\n"
                f"If you didn't ask for this, you can ignore the email — your account is still safe.\n\n"
                f"— {MAIL_FROM_NAME}"
            ),
        )
        return _send(self, 200, {"ok": True, "gmail": user["gmail"]})

    def _verify_code(self):
        body = _read_json(self)
        username = str(body.get("username") or "").strip()
        code     = str(body.get("code")     or "").strip()
        purpose  = str(body.get("purpose")  or "").strip()

        if not username or not code or purpose not in ("signup", "forgot"):
            return _send(self, 400, {"error": "Missing required fields."})

        # Throttle 5-digit-code brute force.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in (f"code:{purpose}:{username.lower()}", ip_key):
            locked, retry = _rl_consume(
                _code_buckets, key, now_ms,
                _CODE_MAX_FAILS, _CODE_WINDOW_MS, _CODE_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        result = consume_code(username, code, purpose)
        if "error" in result:
            return _send(self, 400, {"error": result["error"]})
        # Successful code redemption: clear the per-username bucket.
        _rl_success(_code_buckets, f"code:{purpose}:{username.lower()}")

        if purpose == "signup":
            with _lock:
                pendings = load_pendings()
                pending  = pendings.get(username.lower())
                if not pending:
                    return _send(self, 400, {"error": "No pending signup found. Restart the process."})
                users = load_users()
                if any(u["username"].lower() == username.lower() for u in users):
                    return _send(self, 409, {"error": "That username was just taken. Try again."})
                if any((u.get("gmail") or "").lower() == pending["gmail"].lower() for u in users):
                    return _send(self, 409, {"error": "That Gmail was just taken. Try again."})
                user = {
                    "id": secrets.token_hex(8),
                    "username": pending["username"],
                    "pinHash":  pending["pinHash"],
                    "gmail":    pending["gmail"],
                    "gmailVerified": True,
                    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                users.append(user)
                save_users(users)
                pendings.pop(username.lower(), None)
                save_pendings(pendings)

            send_email(
                to=pending["gmail"],
                subject="Welcome to the 1% Healthy Habit Circle",
                text=(
                    f"Hi {username},\n\n"
                    f"Welcome to the 1% Healthy Habit Circle.\n\n"
                    f"Your account is ready. You can sign in at:\n"
                    f"{FRONTEND_URL}\n\n"
                    f"Username: {username}\n\n"
                    f"— {MAIL_FROM_NAME}"
                ),
            )
            return _send(self, 200, {"ok": True})

        # purpose == "forgot"
        token = issue_reset_token(username)
        return _send(self, 200, {"ok": True, "resetToken": token})

    def _reset_with_pin(self):
        body = _read_json(self)
        token = str(body.get("resetToken") or "")
        pin   = str(body.get("pin")        or "").strip()

        if not token:
            return _send(self, 400, {"error": 'Missing reset token. Start the "Forgotten Password" flow again.'})
        if not PIN_RE.match(pin):
            return _send(self, 400, {"error": "Please, enter a six digit password."})

        # Throttle token guessing. A token is 24 random hex bytes
        # (192 bits) so the search space is huge, but limit request
        # volume anyway in case a sloppy bug ever weakens tokens.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        for key in ("reset:" + token[:8], ip_key):
            locked, retry = _rl_consume(
                _code_buckets, key, now_ms,
                _CODE_MAX_FAILS, _CODE_WINDOW_MS, _CODE_LOCKOUT_MS,
            )
            if locked:
                return _send(self, 429, _rl_locked_response(retry))

        entry = consume_reset_token(token)
        if not entry:
            return _send(self, 400, {"error": 'Your reset session expired. Try "Forgotten Password" again.'})

        with _lock:
            users = load_users()
            user = next((u for u in users if u["username"].lower() == entry["username"]), None)
            if not user:
                return _send(self, 400, {"error": "No account matches that reset token."})
            user["pinHash"]   = hash_pin(pin)
            user["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            save_users(users)

        return _send(self, 200, {"ok": True})

    # ---------- messages, replies, per-student archive ----------

    def _get_student_archive(self):
        """GET /api/student-archive?username=X
        Returns that student's personal archive (rows from
        .student-archive.json with studentUsername == X), newest first,
        capped to 100. The student page renders these in the same
        archive drawer the global archive uses, scoped to "your own
        archive". A teacher who hits this endpoint is given their own
        username's archive (which is normally empty since teachers
        don't view notifications the way students do)."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
        except Exception:
            qs = {}
        username = (qs.get("username") or [""])[0].strip().lower()
        if not username:
            return _send(self, 400, {"error": "Pass ?username=X."})
        with _lock:
            try:
                sa = load_student_archive()
            except Exception:
                sa = []
        rows = [
            r for r in (sa if isinstance(sa, list) else [])
            if isinstance(r, dict)
            and str(r.get("studentUsername") or "").strip().lower() == username
        ]
        rows.sort(
            key=lambda r: r.get("archivedAt") or r.get("createdAt") or 0,
            reverse=True,
        )
        return _send(self, 200, {"ok": True, "items": rows[:100]})

    def _get_replies(self):
        """GET /api/replies?parentId=X  -> { ok, items: [...] }
           GET /api/replies?student=X   -> { ok, byStudent: { user: [...] } }

        Used by:
        - Student page: ?parentId=X to render the "your past replies"
          list under a message card.
        - Teacher's page: ?student=X (no param actually; the teacher
          hits the no-arg variant which returns ALL replies grouped by
          student username — see below) to render the Replies section.
        """
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
        except Exception:
            qs = {}
        parent_id = (qs.get("parentId") or [""])[0].strip()
        student   = (qs.get("student")  or [""])[0].strip().lower()

        # Per-IP rate limit (generous — these are cheap reads).
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        locked, retry = _rl_consume(
            _reply_get_buckets, ip_key, now_ms,
            120, 60 * 1000, 60 * 1000,
        )
        if locked:
            return _send(self, 429, _rl_locked_response(retry))

        with _lock:
            try:
                replies = load_replies()
            except Exception:
                replies = []
        if not isinstance(replies, list):
            replies = []

        if parent_id:
            items = [r for r in replies if isinstance(r, dict)
                     and str(r.get("parentId") or "") == parent_id]
            items.sort(key=lambda r: r.get("createdAt") or 0)
            return _send(self, 200, {"ok": True, "items": items})
        if student:
            items = [r for r in replies if isinstance(r, dict)
                     and str(r.get("studentUsername") or "").strip().lower() == student]
            items.sort(key=lambda r: r.get("createdAt") or 0)
            return _send(self, 200, {"ok": True, "items": items})

        # No filter — return the whole thing grouped by student. Used
        # by the Teacher's Replies section to render the per-student
        # button grid in a single round-trip. The grouping is stable
        # (insertion order of first-seen username) and items within
        # each group are sorted newest-first.
        by_student: "dict[str, list]" = {}
        for r in replies:
            if not isinstance(r, dict):
                continue
            u = str(r.get("studentUsername") or "").strip()
            if not u:
                continue
            by_student.setdefault(u, []).append(r)
        for u in by_student:
            by_student[u].sort(key=lambda r: r.get("createdAt") or 0, reverse=True)
        return _send(self, 200, {"ok": True, "byStudent": by_student})

    def _post_signout(self):
        """POST /api/signout  { username }
        Copies every active notification the username has viewed into
        .student-archive.json with archiveReason "signed-out", removes
        the username from each such notification's viewedBy, then runs
        a sweep. The notifications stay in the global active list so
        other students (and this student on re-sign-in) can still see
        them — the per-student archive is the "I've seen this" list.
        """
        try:
            body = _read_json(self)
        except Exception:
            return _send(self, 400, {"error": "Invalid request body."})
        username = str(body.get("username") or "").strip().lower()
        if not username:
            return _send(self, 400, {"error": "Pass a username."})

        # No teacher gate on this endpoint: the student triggers it
        # implicitly when they sign out. We do still verify the user
        # exists so a typo doesn't pollute the archive.
        with _lock:
            users = load_users()
            if not any(u.get("username", "").lower() == username for u in users):
                return _send(self, 404, {"error": "No account with that username."})

            notifs = load_notifications()
            if not isinstance(notifs, list):
                notifs = []
            sa = load_student_archive()
            if not isinstance(sa, list):
                sa = []
            now_ms = _rl_now()
            moved = 0
            for n in notifs:
                if not isinstance(n, dict):
                    continue
                viewed = [str(v).lower() for v in (n.get("viewedBy") or [])]
                if username not in viewed:
                    continue
                # Append a per-student archive row.
                sa.append({
                    "id": "sa-" + secrets.token_hex(6),
                    "sourceId": n.get("id"),
                    "kind": "notification",
                    "title": str(n.get("title") or ""),
                    "body":  str(n.get("body")  or ""),
                    "createdAt": n.get("createdAt") or now_ms,
                    "archivedAt": now_ms,
                    "archiveReason": "signed-out",
                    "studentUsername": username,
                })
                moved += 1
                # Drop the username from viewedBy so the global
                # all-viewed sweep re-evaluates.
                n["viewedBy"] = [v for v in n.get("viewedBy") or []
                                 if str(v).lower() != username]

            # Cap the per-student archive so a long-running school
            # year doesn't bloat the file. Keep the most recent 200
            # rows per student (good enough; cap is loose).
            if len(sa) > 500:
                sa = sa[-500:]
            save_notifications(notifs)
            save_student_archive(sa)

            # Re-sweep: a notification whose only viewer just signed
            # out no longer meets the all-viewed condition and pops
            # back into the active list.
            self._sweep_archives_locked()

        return _send(self, 200, {"ok": True, "moved": moved})

    def _post_replies(self):
        """POST /api/replies (multipart)  — student posts a reply.
        Form fields: parentId, parentKind, studentUsername, text?,
        mediaType?, media? (file).
        - parentKind ∈ {"challenge", "message"}
        - mediaType ∈ {"text", "image", "video", "audio"} — for
          challenges this must match the challenge's returnType; for
          messages it must be one of {"text", "audio"}.
        - The text part and the media part are independently optional
          but at least one must be non-empty.
        - File size cap: 15 MB. Mime must be image/*, video/*, or
          audio/*.
        """
        # Per-IP rate-limit. 30 posts / 5 min / IP — generous for a
        # class of students (a few in-flight posts at a time) but
        # stops a runaway client.
        now_ms = _rl_now()
        ip_key = "ip:" + _client_ip(self)
        locked, retry = _rl_consume(
            _reply_post_buckets, ip_key, now_ms,
            30, 5 * 60 * 1000, 5 * 60 * 1000,
        )
        if locked:
            return _send(self, 429, _rl_locked_response(retry))

        # Cap the request body so a malicious client can't OOM us
        # before we even parse it. 16 MB leaves headroom over the
        # 15 MB media cap for multipart overhead + other fields.
        try:
            clen = int(self.headers.get("Content-Length") or 0)
        except Exception:
            clen = 0
        if clen > _REPLY_MAX_MEDIA_BYTES + 1024 * 1024:
            return _send(self, 413, {"error": "Upload too large. Keep media under 15 MB."})

        # Parse the multipart body. FieldStorage is fine on Python
        # 3.12 (the env's current version); if we ever move past 3.13
        # we'd need to swap this for email.parser. Defensive try/
        # except around the import + parse so a weird cgi quirk
        # doesn't take down the whole request thread.
        try:
            import cgi as _cgi  # type: ignore
            fs = _cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={"REQUEST_METHOD": "POST"},
            )
        except Exception as e:
            return _send(self, 400, {"error": f"Could not parse upload: {e}"})

        def _form(name):
            f = fs.getfirst(name) if fs else None
            if f is None:
                return ""
            return str(f)

        parent_id   = _form("parentId").strip()
        parent_kind = _form("parentKind").strip().lower()
        student     = _form("studentUsername").strip().lower()
        text        = _form("text").strip()
        media_type  = _form("mediaType").strip().lower()

        if not parent_id:
            return _send(self, 400, {"error": "Missing parentId."})
        if parent_kind not in ("challenge", "message"):
            return _send(self, 400, {"error": "Invalid parentKind."})
        if not student:
            return _send(self, 400, {"error": "Missing studentUsername."})
        if media_type and media_type not in ("text", "image", "video", "audio"):
            return _send(self, 400, {"error": "Invalid mediaType."})

        # The file part, if any.
        # cgi.FieldStorage instances cannot be coerced to bool, so test
        # for the underlying `file` attribute explicitly.
        file_item = fs["media"] if "media" in fs else None
        file_value = getattr(file_item, "file", None) if file_item is not None else None
        file_name  = str(getattr(file_item, "filename", "") or "") if file_item is not None else ""
        # FieldStorage surfaces "no file selected" as an empty filename
        # on some clients; treat that as "no media".
        has_file = (file_value is not None) and bool(file_name)
        if has_file and media_type == "text":
            # The client declared text-only but also sent a file. Honor
            # the text-only declaration — drop the file silently. (We
            # could 400 here, but it's friendlier to the student.)
            has_file = False
        if has_file and not media_type:
            media_type = "image"  # safe default for an unattributed file

        if not text and not has_file:
            return _send(self, 400, {"error": "Add a note or a file before sending."})
        if len(text) > 1000:
            return _send(self, 400, {"error": "Text is too long (1000 characters max)."})

        # Verify the student is enrolled.
        with _lock:
            users = load_users()
            if not any(u.get("username", "").lower() == student for u in users):
                return _send(self, 404, {"error": "No account with that username."})

            # Verify the parent exists and (for challenges) that the
            # mediaType matches the challenge's returnType.
            parent = None
            if parent_kind == "challenge":
                ch = load_challenge()
                if isinstance(ch, dict) and str(ch.get("id") or "") == parent_id:
                    parent = ch
                else:
                    return _send(self, 404, {"error": "Challenge no longer exists."})
            else:
                msgs = load_messages()
                if isinstance(msgs, list):
                    for mm in msgs:
                        if isinstance(mm, dict) and str(mm.get("id") or "") == parent_id and not mm.get("archived"):
                            parent = mm
                            break
                if parent is None:
                    return _send(self, 404, {"error": "Message no longer exists."})

            # Validate mediaType vs parent. For messages we allow any
            # of text / image / video / audio — the student can reply
            # with any combination (or just one). For challenges the
            # returnType dictates what's allowed.
            allowed_media = []
            if parent_kind == "message":
                allowed_media = ["text", "image", "video", "audio"]
            else:
                rt = parent.get("returnType")
                if rt in ("image", "video", "audio"):
                    allowed_media = ["text", rt]
                elif rt == "text":
                    allowed_media = ["text"]
                else:
                    # Legacy challenge (no returnType): behave like
                    # "text" so the legacy "mark done" flow still
                    # works through the new reply endpoint.
                    allowed_media = ["text"]

            if has_file and media_type not in allowed_media:
                return _send(self, 400, {
                    "error": f"This {parent_kind} expects replies of type: {', '.join(allowed_media)}."
                })
            if (not has_file) and "text" not in allowed_media:
                # Text-only reply but the parent only allows media.
                # We allow it for messaging-style parents (audio +
                # text) but reject for image/video-only challenges so
                # the student sees a clear error.
                if parent_kind == "challenge":
                    return _send(self, 400, {
                        "error": f"This challenge expects a {', '.join(allowed_media)} reply."
                    })

            # Generate the reply id up-front. We use the same id on
            # disk for the file (when present) and on the row, so a
            # media file's basename reveals which row it belongs to.
            new_id = "r-" + secrets.token_hex(8)

            # MIME sanity on the file (when present).
            media_mime = ""
            media_size = 0
            media_url = None
            if has_file:
                media_mime = str(getattr(file_item, "type", "") or "")
                if not (media_mime.startswith("image/") or
                        media_mime.startswith("video/") or
                        media_mime.startswith("audio/")):
                    return _send(self, 400, {
                        "error": "File type not supported. Use an image, video, or audio recording."
                    })

                # Best-effort extension from the original filename so
                # browsers can play it back. Sniff only the last
                # segment to avoid "../" games.
                ext = ""
                if file_name:
                    base = os.path.basename(file_name)
                    _, e = os.path.splitext(base)
                    if e and len(e) <= 8 and all(c.isalnum() or c in "._-" for c in e[1:]):
                        ext = e
                if not ext:
                    ext = ".bin"
                out_name = f"{new_id}{ext}"
                out_path = MEDIA_DIR / out_name

                # Stream the upload to disk in chunks so we can bail
                # out early if it exceeds the cap (instead of holding
                # the whole file in memory).
                written = 0
                try:
                    with open(out_path, "wb") as out:
                        while True:
                            chunk = file_value.read(64 * 1024)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > _REPLY_MAX_MEDIA_BYTES:
                                out.close()
                                try: out_path.unlink()
                                except Exception: pass
                                return _send(self, 413, {
                                    "error": "File too large. Keep media under 15 MB."
                                })
                            out.write(chunk)
                except Exception as e:
                    return _send(self, 500, {
                        "error": f"Could not save the file: {e}"
                    })
                media_size = written
                media_url = f"/media/{out_name}"
            row = {
                "id": new_id,
                "parentId": parent_id,
                "parentKind": parent_kind,
                "studentUsername": student,
                "text": text,
                "mediaType": (media_type if has_file else ("text" if text else None)),
                "mediaUrl": media_url,
                "mediaMime": media_mime,
                "mediaSize": media_size,
                "createdAt": now_ms,
            }
            replies = load_replies()
            if not isinstance(replies, list):
                replies = []
            replies.append(row)
            # Cap so a misbehaving client can't unbounded-grow the
            # file. 2000 rows is many classes' worth of replies.
            if len(replies) > 2000:
                replies = replies[-2000:]
            save_replies(replies)

        return _send(self, 200, {
            "ok": True,
            "id": new_id,
            "mediaUrl": media_url,
        })

    def _serve_media(self, filename: str):
        """GET /media/<file> — serve an uploaded reply media file.
        Filename is the basename only (we strip any path components
        before opening). Range requests are NOT supported — the files
        are small and the server is single-process."""
        # Sanitize: only the basename. No slashes, no "..", no
        # absolute paths. (MEDIA_DIR is fixed so this is a belt-and-
        # braces measure.)
        safe = os.path.basename(filename)
        if not safe or safe != filename:
            return _send(self, 400, {"error": "Bad filename."})
        full = (MEDIA_DIR / safe).resolve()
        try:
            # Ensure the resolved path is still under MEDIA_DIR.
            media_resolved = MEDIA_DIR.resolve()
            if not str(full).startswith(str(media_resolved)):
                return _send(self, 400, {"error": "Bad filename."})
        except Exception:
            return _send(self, 400, {"error": "Bad filename."})
        if not full.exists() or not full.is_file():
            return _send(self, 404, {"error": "Not found."})

        # Pick a content-type from the extension; fall back to
        # application/octet-stream. (We don't use Python's mimetypes
        # because it would require a system mime DB and we're keeping
        # the stdlib footprint small.)
        ext = full.suffix.lower()
        ctype = {
            ".jpg":  "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png":  "image/png",
            ".gif":  "image/gif",
            ".webp": "image/webp",
            ".mp4":  "video/mp4",
            ".webm": "video/webm",
            ".mov":  "video/quicktime",
            ".mp3":  "audio/mpeg",
            ".wav":  "audio/wav",
            ".ogg":  "audio/ogg",
            ".m4a":  "audio/mp4",
            ".bin":  "application/octet-stream",
        }.get(ext, "application/octet-stream")

        try:
            data = full.read_bytes()
        except Exception:
            return _send(self, 500, {"error": "Could not read file."})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=300")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    # ---------- static file serving ----------
    def _serve_static(self, url_path: str):
        """Serve a static file from STATIC_DIR (= FINISHED/, the parent
        of server/). Used to host the four HTML pages out of the same
        Python process on Render.

        Path-traversal protection: resolve the candidate path and
        confirm it stays under STATIC_DIR. Anything outside the tree
        raises _NotStatic so the caller falls through to the 404
        handler."""
        # Drop query string + decode.
        clean = url_path.split("?", 1)[0]
        # "/" maps to Login/index.html by convention so the deployed
        # URL `https://x.onrender.com/` lands on the login page.
        if clean in ("", "/"):
            clean = "/Login/"
        # Only serve paths that look like absolute paths into our tree.
        if not clean.startswith("/"):
            raise _NotStatic()
        # Reject obvious traversal early.
        if ".." in clean:
            raise _NotStatic()
        # Map to disk.
        rel = clean.lstrip("/")
        # Teacher's folder has an apostrophe in the name.
        # Path on disk uses the literal apostrophe.
        full = (STATIC_DIR / rel).resolve()
        try:
            static_resolved = STATIC_DIR.resolve()
            if not str(full).startswith(str(static_resolved)):
                raise _NotStatic()
        except _NotStatic:
            raise
        except Exception:
            raise _NotStatic()
        if full.is_dir():
            # Convention: trailing-slash directories serve index.html.
            idx = full / "index.html"
            if idx.is_file():
                return self._send_static_file(idx)
            # No index.html — 404.
            raise _NotStatic()
        if full.is_file():
            return self._send_static_file(full)
        raise _NotStatic()

    def _send_static_file(self, full: Path):
        # Tiny content-type map; fall back to octet-stream. The pages
        # reference a few text/* + image/* + font/* + js/css mime types;
        # the browser is forgiving on text/css vs text/plain so this
        # minimal map is fine.
        ext = full.suffix.lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".htm":  "text/html; charset=utf-8",
            ".css":  "text/css; charset=utf-8",
            ".js":   "application/javascript; charset=utf-8",
            ".mjs":  "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg":  "image/svg+xml",
            ".png":  "image/png",
            ".jpg":  "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif":  "image/gif",
            ".webp": "image/webp",
            ".ico":  "image/x-icon",
            ".woff": "font/woff",
            ".woff2":"font/woff2",
            ".ttf":  "font/ttf",
            ".otf":  "font/otf",
            ".txt":  "text/plain; charset=utf-8",
            ".map":  "application/json; charset=utf-8",
        }.get(ext, "application/octet-stream")
        try:
            data = full.read_bytes()
        except Exception:
            raise _NotStatic()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Static assets benefit from a small cache. HTML gets a short
        # one so deploys propagate quickly.
        if ext in (".html", ".htm"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass


class _NotStatic(Exception):
    """Sentinel raised by _serve_static when the URL isn't a static
    file we should serve. The do_GET caller catches it and falls
    through to the /api/* 404 handler."""
    pass

# ---------- bootstrap ----------

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    # Make sure the media upload dir exists before we start accepting
    # multipart POSTs to /api/replies.
    try:
        MEDIA_DIR.mkdir(exist_ok=True)
    except Exception as e:
        print(f"[store] could not create {MEDIA_DIR}: {e}", file=sys.stderr)

    # Initialise the storage backend. Mongo takes priority if MONGODB_URI
    # is set + pymongo is importable; otherwise we fall back to local
    # JSON files (developer convenience).
    _storage_init()
    _storage_indexes()

    if not can_send_email():
        print(f"[auth] No email backend configured — emails will be SKIPPED. Set RESEND_API_KEY (hosted) or GMAIL_USER + GMAIL_APP_PASSWORD (dev) to enable.", file=sys.stderr)
    elif RESEND_API_KEY:
        print(f"[auth] Email: Resend (sender={MAIL_FROM})", file=sys.stderr)
    else:
        print(f"[auth] Email: Gmail ({GMAIL_USER})", file=sys.stderr)
    print(f"[auth] 1% Healthy Habit backend listening on {PUBLIC_BASE_URL}", file=sys.stderr)
    print(f"[auth] Frontend URL (for welcome email): {FRONTEND_URL}", file=sys.stderr)
    print(f"[auth] WhatsApp fallback: {WHATSAPP_NUMBER}", file=sys.stderr)
    if TEACHER_USERNAME and TEACHER_PASSWORD and not TEACHER_USERNAME.startswith("replace_") and not TEACHER_PASSWORD.startswith("replace_"):
        print(f"[auth] Teacher sign-in: ENABLED (user={TEACHER_USERNAME}, landing={TEACHER_LANDING})", file=sys.stderr)
    else:
        print(f"[auth] Teacher sign-in: DISABLED (set TEACHER_USERNAME and TEACHER_PASSWORD in .env to enable)", file=sys.stderr)
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == "__main__":
    main()

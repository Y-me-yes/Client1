# 1% Healthy Habit — Auth backend

Tiny Python HTTP server that handles signup, signin, forgot, code-verify,
and PIN-reset for the Login page.

**No external dependencies.** Just Python 3.

## Run it

```powershell
cd "path\to\FINISHED\server"
copy .env.example .env
# (optional) edit .env and fill in your Gmail + App Password
py -3 server.py
```

The server starts on **http://localhost:3000** by default.

The simplest way to start everything: double-click
`..\Login\Start Website.bat`. It opens the Login page **and** launches
the backend in a separate window.

## Endpoints

| Method | Path                     | Body                                          |
|-------:|--------------------------|-----------------------------------------------|
| GET    | `/api/health`            | —                                             |
| GET    | `/api/students`          | —                                             |
| GET    | `/api/gradebook`         | —                                             |
| POST   | `/api/signup`            | `{ username, pin, gmail? }`                   |
| POST   | `/api/signup-send-code`  | `{ username, pin, gmail }`                    |
| POST   | `/api/signin`            | `{ username, pin }`                           |
| POST   | `/api/teacher-signin`    | `{ username, password }`                      |
| POST   | `/api/forgot`            | `{ username }`                                |
| POST   | `/api/verify-code`       | `{ username, code, purpose }`                 |
| POST   | `/api/reset-with-pin`    | `{ resetToken, pin }`                         |
| POST   | `/api/rename-username`   | `{ oldUsername, newUsername, pin }`           |
| GET    | `/api/content?username=X`| `username` records a view for active notifications. Response: `{ active, archive, studentArchive?, now }` |
| POST   | `/api/content`           | `{ kind, text?/title?/body?, expiresAt?, returnType?, teacherPassword }` — `kind` ∈ `daily-challenge`, `new-challenge`, `notification`, `message` |
| POST   | `/api/content/<id>/archive` | `{ teacherPassword }`                     |
| POST   | `/api/signout`           | `{ username }` — moves viewed notifications into that student's per-student archive |
| GET    | `/api/student-archive?username=X` | —                                  |
| GET    | `/api/replies?parentId=X`| All replies on one challenge/message          |
| GET    | `/api/replies?student=X` | All replies by one student                    |
| GET    | `/api/replies`           | All replies, grouped by student               |
| POST   | `/api/replies`           | multipart: `parentId, parentKind, studentUsername, text?, mediaType?, media?` |
| GET    | `/media/<file>`          | Serves an uploaded reply media file           |

## Storage

User records are kept in `users.json` next to this file. **Dev only.**
Swap for a real database (MongoDB Atlas) before going live.

`pendings.json`, `codes.json`, and `resets.json` are transient — they
hold in-flight signups, 5-digit verification codes, and PIN-reset
tokens.

## Email (Gmail)

1. Turn on 2-Step Verification on your Google account.
2. Create an App Password at https://myaccount.google.com/apppasswords
   (Google shows it with spaces — strip the spaces before pasting
   into `.env`).
3. Put it in `.env` as `GMAIL_APP_PASSWORD=...`
4. Set `GMAIL_USER=your.email@gmail.com`

If `.env` is missing the placeholders, emails are silently skipped and
a warning is logged. The rest of the API still works.

## Recovering without Gmail

If a user has no Gmail on file, the "Forgotten Password" flow returns
`{ ok: true, reason: 'no-gmail' }` and the frontend tells them to
message the configured `WHATSAPP_NUMBER` on WhatsApp.

## Content (challenges + notifications + messages + replies + archive)

The teacher's **+** button (FAB) opens a four-option popup that posts
to `/api/content` with `kind` ∈ `daily-challenge`, `new-challenge`,
`notification`, or `message`. The student page polls
`/api/content?username=<u>` — that GET is what records a "view" for
the username against every active notification. Once a notification
has been viewed by every enrolled student, it auto-archives with
`archiveReason: "all-viewed"`. A daily / new challenge auto-archives
with `archiveReason: "expired"` when its `expiresAt` ms-timestamp has
passed. Teachers can also manually archive any item with
`POST /api/content/<id>/archive`.

**Return type for challenges.** When a teacher posts a daily or new
challenge, the dialog accepts an optional `returnType` ∈
`{text, image, video, audio, null}`. `null` (or missing) keeps the
legacy "Mark done" flow. Any other value flips the student-side card
to show a "Submit" button that opens a reply dialog scoped to that
type.

**Messages vs. notifications.** Notifications are one-way, view-tracked,
and auto-archive when every student has seen them. Messages are
different: they accept replies (text + audio recording), don't track
views, and don't auto-archive (the teacher manually archives them).
Messages live in `.messages.json`; archived messages are soft-deleted
(kept in the file with `archived: true`).

**Replies.** Students post replies to `/api/replies` (multipart). Every
reply has BOTH a text part and a media part, each independently
optional — at least one must be non-empty. For challenges, the media
type is validated against the challenge's `returnType`; for messages,
text + audio are always allowed. Media is stored under `media/` and
served at `/media/<file>`. Cap: 15 MB per upload, MIMEs limited to
`image/*`, `video/*`, `audio/*`. Multiple replies per student per
parent are allowed.

**Per-student archive.** When a student signs out, the client calls
`POST /api/signout { username }`. The server copies every active
notification that student has viewed into `.student-archive.json`
with `archiveReason: "signed-out"`, then removes the username from
each such notification's `viewedBy` (and re-sweeps, so a notification
whose only viewer just signed out pops back into the active list).
The student sees their personal archive as the third tab in the
student-page archive drawer; the teacher still has the global
archive, which is unaffected by sign-out.

The legacy `GET /api/challenge`, `PUT /api/challenge`, and
`/api/challenge/done` endpoints are still served — the Student page
keeps using them, and the legacy path now understands the new
`expiresAt` field for cross-midnight custom challenges.

## Deploy later

This folder can be deployed to Render.com (free tier) as a Python
service. Point it at a real MongoDB Atlas cluster when you're ready
to leave dev storage. (The Python file uses only standard-library
modules so deployment is a single-file push.)

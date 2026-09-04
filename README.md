# 1% Healthy Habit

Three small web apps in one folder, all client-side vanilla JS — no
build step, no `node_modules`, no `package.json`. Open one of the
launchers and a window pops up with the right URL.

| Folder      | What it is                                                   | Port   | Launcher                          |
|-------------|--------------------------------------------------------------|--------|-----------------------------------|
| `Students/` | Student Score Tracker — offline-first gradebook for students | 8000   | `Start Website.bat`               |
| `Teacher's/`| Teacher dashboard for the Tracker (principal view)           | 8765   | `Start Website.bat`               |
| `Login/`    | Sign-in / sign-up page (1% Healthy Habit Circle)             | 8001+  | `Start Website.bat`               |
| `server/`   | Python auth backend (signup, signin, forgot, PIN reset)      | 3000   | (launched by `Login/Start Website.bat`) |

## Quick start (Windows)

1. **Sign-up backend only** (if you want people to actually create
   accounts):

   ```powershell
   cd server
   copy .env.example .env
   # edit .env and set GMAIL_USER + GMAIL_APP_PASSWORD (optional, but
   # needed for the "Forgotten Password" flow to send real emails)
   ```

   You can skip this and the Login page will still let people sign in —
   it just won't be able to send password-reset emails.

2. **Run the apps.** Double-click any `Start Website.bat`. The Login
   launcher also opens the Python backend in a second window.

   - `Students/Start Website.bat`  → Tracker (port 8000)
   - `Teacher's/Start Website.bat` → Teacher dashboard (port 8765)
   - `Login/Start Website.bat`     → Login page + auth backend (8001+)

   Keep the launcher window **open** while using the site. Close it
   (or `Ctrl+C` in the case of the PowerShell-based ones) to stop the
   server.

3. To use the **full flow** (signup → signin → Tracker), open all three
   launchers in this order: backend first (`Login/Start Website.bat`),
   then the Tracker, then the Teacher dashboard.

## What you need installed

- **Any modern browser** (Chrome, Edge, Firefox).
- **Python 3** — only the `Login` flow needs it. Get it from
  https://www.python.org/downloads/ and tick "Add Python to PATH" during
  install.
- Nothing else. The two Tracker launchers use PowerShell (built into
  Windows) and the Teacher's launcher uses Python's stdlib
  `http.server`.

## How the apps fit together

```
                    +------------------+
                    |  Login page      |
                    |  http://         |
                    |  localhost:8001  |
                    +---------+--------+
                              |
              signin/signup   |  (POSTs to the auth backend
                              |   on http://localhost:3000)
                              v
                    +------------------+
                    |  Python auth     |
                    |  backend         |
                    |  port 3000       |
                    +------------------+

After a successful signin, the user is redirected to either:

   students  --> http://localhost:8000/         (Students/index.html)
   teachers  --> http://localhost:8765/         (Teacher's/index.html)
```

Each Tracker app is **self-contained** — it stores all its data in
`localStorage` on the browser that opens it. To move data between
machines, use the in-app **Export** / **Import** buttons.

## Secrets & Git

This folder is **safe to push to GitHub as-is** — the real `.env` is
deliberately excluded by both the top-level `.gitignore` and the one
in `server/`. Only the placeholder `server/.env.example` is checked
in.

If you ever had a `.env` with real Gmail credentials in the tree,
**rotate that Gmail App Password immediately** (Google account →
Security → App passwords). Git history is forever.

See [`server/README.md`](server/README.md) for backend setup details.

## Folder layout

```
FINISHED/
├── README.md                       ← you are here
├── .gitignore
│
├── Students/                       ← Student Score Tracker
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   ├── assets/...
│   ├── serve.ps1                   ← static server (PowerShell)
│   └── Start Website.bat           ← double-click to run
│
├── Teacher's/                      ← Teacher dashboard
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   ├── assets/...
│   └── Start Website.bat
│
├── Login/                          ← 1% Healthy Habit Circle (auth UI)
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   ├── assets/...
│   ├── serve.ps1                   ← static server (PowerShell)
│   ├── current-url.txt             ← written at runtime (gitignored)
│   ├── serve.log                   ← written at runtime (gitignored)
│   └── Start Website.bat           ← double-click to run
│
└── server/                         ← Python auth backend
    ├── server.py
    ├── .env.example                ← copy to .env and fill in
    ├── .env                        ← (gitignored, you create this)
    ├── README.md
    ├── .gitignore
    ├── users.json                  ← (gitignored, created on first signup)
    ├── pendings.json               ← (gitignored)
    ├── codes.json                  ← (gitignored)
    └── resets.json                 ← (gitignored)
```

## Deploying later

- **Students/ + Teacher's/** — pure static. Drop on any web host
  (Netlify, Vercel, GitHub Pages, S3 + CloudFront, a plain nginx).
- **Login/** — same, but the `serve.ps1` is dev-only. The
  `/api/signin` etc. URLs are CORS-allowed for the same origin and for
  `localhost`, so as long as the backend lives at the same host (or
  you tweak CORS in `server/server.py`) you can ship it anywhere.
- **server/** — single-file Python stdlib service. Render.com free
  tier, Fly.io, Railway, or any VPS works. Swap the JSON files for
  MongoDB Atlas when you go live (the file is already structured to
  make that easy).

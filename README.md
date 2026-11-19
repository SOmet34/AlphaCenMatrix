# BEST Robotics Test Log

A one-phone practice tracker for comparing two robot designs. Create a task,
name two designs, and tap **Success** or **Miss** for each run. Results stay in
the same test, are saved in the browser with `localStorage`, and can be exported
as CSV. No accounts, backend, API keys, or build step.

## Screens

- **First visit — “What are you testing?”** Task name plus two design names,
  then **Start test**.
- **Practice screen** — task name, a **Logging runs for** selector with a check
  mark on the active design, two equal **Success** / **Miss** buttons, and a
  specific confirmation naming the outcome and design with **Undo** beside it.
- **Comparison table** — Design and Record. A record reads `2/3 · 67%`; a design
  with no runs reads `No runs yet`, and a single missed run reads `0/1 · 0%`.
- **Add note** — attaches a note to the most recent run; **Save note** and
  **Cancel** are explicit, and the affected design and outcome stay visible.
- **Recent runs** — newest first, with design, outcome, time, and note.
- **Switch test** — returns to the setup screen and the list of saved tests.
- **Export CSV** — active test only, one row per run: test, design, timestamp,
  outcome, note.

## Files

- `index.html` — the app, at the repository root
- `styles.css` — field-notebook styling and shared CSS variables
- `app.js` — logging, storage, undo, notes, CSV export
- `favicon.svg` — two claw jaws holding a block
- `README.md` — this file

All paths are relative, so the app works at
`https://username.github.io/repository-name/`.

## Preview locally

Open `index.html` directly, or serve the folder:

```bash
cd path/to/this/folder
python -m http.server 8000
```

Then visit <http://localhost:8000>.

Any static server works; for example `npx serve .` if port 8000 is busy.

## Publish on GitHub Pages

1. Create a new empty repository on GitHub, for example `robot-test-tracker`.
2. In this folder:

   ```bash
   git init
   git add index.html styles.css app.js favicon.svg README.md
   git commit -m "Add BEST Robotics test log"
   git branch -M main
   git remote add origin https://github.com/USERNAME/REPO.git
   git push -u origin main
   ```

   Replace `USERNAME` and `REPO` with your GitHub username and repository name.

3. Open the repository on GitHub → **Settings** → **Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
5. Set **Branch** to `main` and the folder to `/ (root)`, then **Save**.
6. After a minute or two, open `https://USERNAME.github.io/REPO/`.

Every later push to `main` redeploys automatically. GitHub Pages on a private
repository requires a GitHub Pro account; a public repository works on the free
plan.

## Data notes

- Tests and runs are stored only in the browser that recorded them. Refreshing
  keeps them; clearing site data, another phone, or another origin does not.
- If storage is blocked, the app says runs are only in memory for that tab and
  keeps **Export CSV** available.
- The CSV includes a UTF-8 BOM and quotes fields containing commas, quotes, or
  line breaks.

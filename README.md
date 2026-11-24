# Frontling — student site

Static, serverless student site for Frontling research projects. Generated from the private
Research-to-Curriculum repository (`site/`); do not edit here, changes are overwritten by `scripts/publish_site.sh`.

- Open a project: `https://team-pj-lab.github.io/frontling-site/#<code>` (demo: `#demo`)
- No server, no login, no API key. Progress stays in the browser; the optional activity log goes to a Google Form (`config.js`).
- Tests: `node --test test/*.test.js`; end-to-end: `NODE_PATH=<dir with jsdom>/node_modules node test/dom.smoke.js`.
- Build: `NODE_PATH=<dir with esbuild>/node_modules node scripts/build.js` writes `dist/`, then `node test/dist.smoke.js`
  checks it, and `CHROME_PATH=<chrome> node test/browser.smoke.js` checks it in real Chrome (CSP, axe, phone width,
  offline worker, kill switch). CI runs all of these and publishes `dist/` (not the source) to `gh-pages`.
- **If the offline worker misbehaves:** set `offline: false` in `config.js` and deploy. Open pages remove it; browsers
  that only load the cached page get a worker that clears the caches and removes itself on their next visit.
- **Backups:** students can save their log to a file and load it on another device ("기록 파일 불러오기"); a file is
  only accepted for the same project and participant and when it has at least as much progress.

## How it stays fast

- **One request for the page.** The build inlines and minifies the CSS, the four scripts and the logo into
  `index.html` (about 15 KB gzipped). The inline bootstrap starts the project file download before anything else.
  Both inline scripts are pinned by hash in the CSP; the build adds the bundle's hash and refuses to finish without it.
- **Instant repeat visits and offline use** (`sw.js`). The page comes from the cache; a new deploy is picked up in the
  background and used from the next visit. Project files are shown from the cache at once and refreshed in the
  background; if the fresh file differs (a reviewer fixed a hint), the open page redraws with it.
- Measured in Chrome with 300 ms added to every request: first visit about 630 ms, repeat visits about 20 ms (also when
  the project file takes 8 s or the device is offline). Lighthouse mobile: 100 in every category.
- Inline vs. a separate bundle file was measured (real Chrome, slow 4G, 4x CPU, first visit): same first paint
  (260 ms), input box on screen at 442 ms inline vs. 577 ms as a file, so the bundle stays inline.

## Publishing packs

Packs must be sealed before they are published: `node scripts/seal_packs.js` (CI refuses unsealed packs).
Sealing hides hint text and quiz answers from anyone opening `packs/<code>.json`.

## What a serverless site can and cannot guarantee

Everything runs on the student's device, so the rules keep honest students on the hint ladder but cannot stop a
determined one. Read the data with that in mind.

- **Sealing is obfuscation, not encryption.** The key is in `core.js`; a student who reads the code can unseal every hint.
- **The hint rules (attempt first, minimum interval, 3 levels) are enforced in the browser.** Editing localStorage skips
  them. A clock moved back is caught and logged (`kind = clock`), a clock moved forward is not.
- **Trust the Google Form timestamp, not the `at` field.** `at` comes from the device clock; the Form's own timestamp is
  set by Google when the row arrives.
- **Anyone can post rows to the Form** (its URL and field ids are public). With the optional `seq` field set in `config.js`,
  every row carries `<sid>:<seq>`: a gap in `seq` is a lost row, the same pair twice is a repeat, and a participant number
  with a second, unknown `sid` may be someone else (or a second device). The student's backup file holds their full record.
- **The distress check is a keyword filter.** It misses indirect wording and must not replace a human reviewing the log.
  Flags (`kind = flag`) carry no text by design; follow up with the student in person.

## Stuck-point suggestions (gets better with every cohort)

After a student saves an attempt, the site marks the stuck point closest to what they wrote ("추천" / "Suggested").
Matching runs on the device in well under a millisecond (character 2-3-grams plus English words, cosine similarity;
`rankStuck` / `recommend` in core.js). A stuck point is described by its label and its three hints (read on the device,
never shown by this).

- **Day one:** labels and hints. Fragments shared by every stuck point of a milestone are ignored.
- **Measured** on 270 student-style messages for the three English projects (written by a separate model that did not
  see the matcher; thresholds chosen on half, checked on the other half): top guess right 82% (labels only: 69-79%);
  a suggestion is shown for about 3 in 4 attempts and is right 90-92% of the time (labels only: 71-83%). Korean has no
  benchmark yet: the demo project's labels are placeholders.
- **After a pilot:** `node scripts/mine_signals.js <form-export.csv> [--cols pid=...,kind=...]` learns from the log which
  fragments preceded which hint, reports leave-one-student-out accuracy (labels only vs. with signals), and with
  `--write` stores the learned weights in the packs as `signals`. Run it in the source repository before sealing.
- **Feedback loop:** students who simply take the shown suggestion count half (`--followed 0.5`), so the model does not
  mostly learn its own guesses; the report also gives accuracy on attempts where no suggestion was shown.
- **Privacy:** packs get 2-3 character fragments with weights, never sentences, and only fragments written by at least
  three different students (`--min-students`).
- **Measuring it:** every hint row in the log carries `rec`, the suggestion shown before it, so how often students take
  the suggestion is visible per project and per cohort.

The code is generic and public; the signals come from our own students' logs, which stay private.

## Which hints work (hint experiments)

- **Ratings:** under the newest hint of a stuck point the student can answer "did this help?" once (`rate` rows).
- **Variants:** a stuck point may carry `variants` (for each of the 3 levels, a list of alternative wordings). Each
  student always gets the same variant (hash of participant number and hint position); the hint row records `v`.
  Variants are sealed like hints.
- **Report:** `node scripts/hint_report.js <form-export.csv> [--final] [--out report.md] [--json]` gives, for every hint, what
  happened after it was opened: resolved (milestone submitted without the next level), escalated (next level opened)
  or still open; minutes to the next attempt; how much that attempt changed; ratings. It queues hints for review when
  they are probably (>= 90%, Beta posterior) below the project's average at that level, or mostly rated unhelpful, and
  picks a variant as the winner when it is best with >= 95% probability and every variant has >= 10 decided cases.
  Groups under 3 students get no numbers; no student text is printed.
- **Mid-cohort vs `--final`:** mid-cohort, a hint the student has not got past yet is "still open" and left out. With
  `--final` (run it once the cohort has ended) it counts as a failure, so a hint that makes students give up is caught.
  The last level (3) has no next level and can only fail by stopping, so mid-cohort it is judged by ratings only.
- **What the thresholds mean (simulated):** with every hint equally good, about 1 in 10 hints still lands in the review
  queue (it is a list for a person to read, not a verdict). Re-running the report after every cohort raises the chance
  of a winner between two equally good variants from 5% to about 13%; that costs nothing (either wording is fine),
  while a variant that is really better (60% → 84% resolved) is found in about 6 of 10 experiments within 8 cohorts of 20.
- **Promote:** `--apply --write` makes each winner the hint and ends that experiment (sealed packs stay sealed).

Pipeline in the source repository, per cohort: export the Form → `hint_report.js` (review queue, experiments) →
`mine_signals.js --write` → `hint_report.js --apply --write` → `seal_packs.js` → publish.

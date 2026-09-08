# NS Ventures Tracker — Recent Changes

Version **1.0.0** · covers commits `3687eb1` → `4877432` (2026-07-23 to 2026-07-24)

A summary of every change made in this round of work, why it was needed, and what
still needs checking on a real machine. Grouped by area; commit hashes in
parentheses.

---

## 1. Logout no longer hangs (`3687eb1`)

**Problem.** Clicking **Logout** appeared to do nothing. Logout waited for a full
data sync to finish before clearing the session, and when the screenshot upload
backlog was large that sync effectively never returned — so the dashboard stayed
on screen and the click looked dead.

**Fix.** The pre-logout sync is now capped at 8 seconds, and session teardown was
moved into a `finally` block so logout always completes even if the sync or
clock-out throws. The header shows "Logging out…" and ignores repeat clicks
during that window. Any un-synced data stays queued locally and uploads after the
next login — nothing is lost.

Files: `AuthContext.tsx`, `UserHeader.tsx`.

---

## 2. Cross-platform packaging (`3687eb1`)

Made the app build and identify correctly on all three platforms.

- **Windows screenshot filenames** were split on `/` only, so on Windows the
  entire `C:\Users\…\file.png` path was sent as the upload filename. Now splits on
  both separators. *(A likely contributor to uploads failing / the backlog.)*
- **`asarUnpack`** glob `**\*.{node,dll}` had an escaped wildcard that matched
  nothing; corrected to `**/*.{node,dll}`.
- **Auto-updater** pointed at the original `electron-react-boilerplate` GitHub
  repo — meaning production builds could have offered *that project's* releases to
  our users as updates. Now points at `nsventures/Nsv-System-Tracker-`, runs only
  in packaged builds, and logs instead of throwing.
- **App identity.** The packaged app called itself `electron-react-boilerplate`;
  app data now lives under **NS Ventures** on every platform. Version set to
  `1.0.0`.
- **macOS Screen Recording.** Screenshots silently returned a blank desktop
  without the permission; capture now checks it and prompts once, deep-linking to
  the right Settings pane.
- **Explicit per-platform targets/arch**, NSIS installer options, deb metadata,
  and `package:win` / `package:linux` / `package:mac` scripts. CI no longer
  cancels the other platforms when one fails and fails loudly if artifacts are
  missing.

Files: `package.json`, `release/app/package.json`, `src/main/main.ts`,
`.github/workflows/build-artifacts.yml`.

**Note:** builds are **unsigned**. Windows shows a SmartScreen warning; macOS
Gatekeeper blocks the app until right-click → Open (or `xattr -cr`). Real
distribution needs a code-signing certificate.

---

## 3. Linux launch crash — SIGTRAP (`e7a4735`)

**Problem.** The Linux `.deb` died on launch with `Trace/breakpoint trap (core
dumped)` — Chromium aborting because it could not set up its sandbox. Distros that
restrict unprivileged user namespaces (Ubuntu 24.04+, 26.04) hit this every time,
so the app never opened.

**Root cause.** `appendSwitch('no-sandbox')` in code runs *after* Chromium has
already initialised its sandbox, so it was too late to help. The flag has to be on
the actual command line. Reproduced and verified in an Ubuntu 24.04 container:
without the flag the process dies with no window; with it the window appears and
the renderer loads.

**Fix.** `linux.executableArgs: ["--no-sandbox"]` so the desktop entry launches
`… --no-sandbox %U`. Autostart carries the flag too. Also: renderer-load failures
now log and the window force-shows after 15 s (previously a failed load left the
app running with no window and no error); startup logs one diagnostic line with
version, platform, and paths.

Files: `package.json`, `src/main/main.ts`.

---

## 4. Linux upgrade over the old package (`ca67aa4`)

**Problem.** Installing over an existing install failed with `trying to overwrite
'/opt/NS Ventures/…' which is also in package electron-react-boilerplate` — the
rename left dpkg treating them as two unrelated packages owning the same folder.

**Fix.** The deb now declares `Conflicts`/`Replaces: electron-react-boilerplate`,
so `apt` removes the old package automatically. Verified in the built artifact.

Files: `package.json`.

---

## 5. Branding (`ab6b5e4`, `cfef35e`)

- **Header logo** always showed the white wordmark, invisible in light mode. It
  now switches with the theme (black wordmark on light, white on dark).
- **Taskbar / executable icon** showed the boilerplate atom icon, because the
  packaging work had pointed `win.icon` at boilerplate art. Removed that override
  so the NS Ventures icon is embedded. Verified by extracting the icon from both
  the app `.exe` and the installer.

Files: `UserHeader.tsx`, `package.json`, `src/main/main.ts`.

> The `assets/` folder still contains leftover boilerplate `icon.ico/.icns/.png/
> .svg` and `assets/icons/`. Nothing references them, but they remain a silent
> fallback — worth replacing or deleting.

---

## 6. Wayland screen-share prompts (`1e7f3fe`)

**Problem.** On a Wayland session the app prompted "share your screen" every few
minutes. `desktopCapturer.getSources()` opens a *new* portal session on each call,
and GNOME asks for consent each time — so the 5-minute screenshot loop prompted
endlessly.

**Fix (Wayland only).** The renderer now holds a **single** `getDisplayMedia()`
stream for the whole login and grabs a still frame from it each interval — one
consent instead of one-per-shot. The system picker lets GNOME offer "remember" for
persistence across restarts; PipeWire is enabled as the transport. Windows, macOS,
and X11 keep the existing capture path untouched.

Files: `src/main/main.ts`, `src/main/preload.ts`,
`src/renderer/services/screenshot.ts`.

**⚠ Needs on-device verification** — could not be tested here (no Wayland
compositor/portal). On the machine: approve the share once, confirm no repeat
prompts across an interval, and that `~/.config/NS Ventures/screenshots/` fills
with non-blank PNGs. GNOME keeps a "screen is being shared" indicator visible;
that is normal for a monitoring tool.

---

## 7. Auto clock-out fixes (`321cd29`, `acaaeb8`)

**Problem.** On some machines the app clocked users out on its own. Two separate
rules were hardcoded to **Indian time** while the app records everything in each
machine's *local* time — so outside India those windows fell across the working
day.

- **Idle auto-clock-out** (30 min idle, 8 PM–6 AM IST) — **removed entirely**.
  Outside India that window covered the workday, and `getSystemIdleTime()`
  over-reports idle on some platforms (Wayland), tripping it even while active.
  Idle is now only logged, never acted on.
- **Suspend/sleep clock-out** (after 7:15 PM IST) — now uses **local time**.
  Sleeping after 7:15 PM local still ends the day (no overnight over-counting); an
  earlier suspend just marks idle.

Manual clock-out and admin force-clock-out are unaffected.

Files: `src/renderer/services/activity.ts`, `src/main/main.ts`.

---

## 8. "Graceful shutdown" clock-out — accurate reason + logging (`4877432`)

**Problem.** A clock-out row labelled *"Gracefully clocked out on PC shutdown"*
appeared when the user hadn't shut down. That label was hardcoded onto **any**
OS-level termination while still clocked in — typically an overnight OS-update
reboot, a log-off, or a suspend.

**Fix.** The reason now reflects the real trigger (system session ended / system
shutdown / application closed), and these lifecycle events are written to
`userData/logs/main.log`, so the cause of a background clock-out is provable
rather than inferred. Behaviour is unchanged — the user is still clocked out (so
they don't show as working overnight); only the recorded reason and logging
improve.

Files: `src/main/main.ts`.

---

## 9. Manual-time diagnostics (`321cd29`)

Reported symptom: "manual time starts by itself." No code path starts manual time
except the dashboard button, so rather than guess, diagnostics were added:
`startManualTime()` logs its call stack and the button handler logs the click.

**⚠ Still needs your log capture.** On the affected machine:

```bash
ns-ventures --no-sandbox 2>&1 | tee ~/nsv-debug.log
```

Reproduce it, then the `[DIAG]` lines show whether a real click reached the
handler, code invoked it (with the caller's stack), or the entry came from the
server. That pinpoints the fix.

---

## Not a bug: DB timestamps 5h30m "behind"

Raw database rows show times 5:30 behind IST because the **server stores UTC**
(best practice) while the desktop app sends naive **IST** wall-clock strings. The
admin dashboard converts back and shows the correct time — confirmed. Reading the
raw column is simply reading UTC. No client change; the client's timestamp format
is fixed by the backend contract (`backend-punching-fixes.md`), and changing it
previously caused spurious force-clockouts.

If old rows were ever stored as raw IST while new ones are UTC, that *within-table*
inconsistency is the real risk — see `backend-punching-fixes.md` §2.1.

---

## Open items / still to verify

| Item | Status |
| --- | --- |
| Wayland screenshots (§6) | **Verify on device** — approve once, check for non-blank PNGs |
| Manual-time symptom (§9) | **Need `~/nsv-debug.log`** from the affected machine |
| Auto clock-out behaviour (§7) | Sanity-check: sleep in the evening → clocks out; midday → doesn't |
| Screenshot upload backlog | Watch whether the queue drains after the filename fix (§2) |
| Code signing | Windows + macOS builds are unsigned; needed for clean distribution |
| Leftover boilerplate icons in `assets/` | Replace or delete (§5) |
| Backend timezone normalisation | Server-side, tracked in `backend-punching-fixes.md` |

---

## Getting the builds

CI builds all three platforms on every push to `main`:
<https://github.com/nsventures/Nsv-System-Tracker-/actions> → newest run →
**Artifacts**: `ns-ventures-windows`, `ns-ventures-mac`, `ns-ventures-linux`.

*Linux:* `sudo apt install ./NSVentures-1.0.0-linux-amd64.deb` (auto-removes the
old package). Launch from the menu, or `ns-ventures --no-sandbox` from a terminal.

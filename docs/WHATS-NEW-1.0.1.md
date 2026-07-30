# What's New — NS Ventures Tracker 1.0.1

A reliability and cross-platform release. Highlights below; caveats at the end so
there are no surprises.

---

## Fixes you'll notice immediately

**Logout actually works.**
Clicking Logout could appear to do nothing (it was waiting on a data sync that
never finished). It now signs out within a moment and shows "Logging out…"
instead of looking frozen.

**No more surprise auto clock-outs from being idle.**
The app used to auto-clock-out after 30 minutes idle inside an evening window
that was hardcoded to Indian time — so on machines in other timezones it fired
during the workday. That rule is removed. (Note: a *separate* "Forcefully clocked
out by administrator" is decided by the server, not the app — see Known Issues.)

**Sleeping the machine clocks out at the right local time.**
The end-of-day sleep clock-out now uses each machine's own local time (7:15 PM
local), not Indian time.

**Correct branding.**
The taskbar/executable icon and the header logo are now the NS Ventures brand —
the logo also switches correctly between light and dark themes (it used to be
invisible in light mode).

**The "Reset App Data" button is back on the login screen.**
It reappears on any failed login again (it had stopped showing when the server's
error wording changed).

---

## Linux

**The app launches.** The Linux build was crashing on startup on modern distros
(Ubuntu 24.04+/26.04) — fixed.

**Clean upgrades.** Installing the new `.deb` now automatically removes the old
package instead of erroring on file conflicts.

**No more constant "share your screen" pop-ups (Wayland).**
On a Wayland desktop the app used to ask for screen-share permission every few
minutes. It now asks once per session and remembers where the system allows it.

---

## Under the hood — accuracy & reliability

These prevent the quiet data problems that corrupt attendance without anyone
noticing:

- **No lost or double-counted punches.** Offline events queue durably and sync
  in order when the network returns, with backoff so a struggling server isn't
  hammered. A stuck item can't loop forever or grow the queue without bound.
- **No double-counting from two copies.** Only one instance of the app can run at
  a time now.
- **No overnight over-counting.** If a machine reboots or sleeps overnight while
  clocked in, the clock-out is stamped at the last active moment — not at the
  next morning's reboot.
- **Blank screenshots are dropped, not uploaded.** Empty/failed captures are
  rejected and logged instead of stored as useless evidence.
- **One source of truth for clock state**, so the dashboard and the tracker can
  never disagree about whether you're clocked in.
- **Crashes and lifecycle events are now logged to a file** for support, instead
  of vanishing silently.

---

## Known issues / not included in this release

- **"Forcefully clocked out" while actively working is a SERVER issue**, not this
  app. The desktop app is correctly obeying a `FORCE_CLOCKOUT` signal the backend
  sends — the fix for that lives in the Laravel server (day-boundary/timezone
  logic), not here.
- **macOS is unsigned.** Gatekeeper will warn on first launch (right-click →
  Open, or `xattr -cr`). Auto-update on Mac needs an Apple certificate.
- **Linux auto-update needs the AppImage.** The `.deb` cannot self-update; a
  machine must switch to the AppImage once to get hands-off updates afterward.
- **Not yet verified on real Linux/macOS hardware.** Windows is smoke-tested and
  the core logic is unit-tested; the Wayland screenshot path and Linux
  sleep/shutdown behavior were validated in a container/by reasoning, not on a
  physical machine.

---

## For Windows users

Auto-update works from this release onward — once 1.0.1 is published, installed
copies pick it up and apply it on the next restart. (The very first install of an
unsigned build shows a SmartScreen prompt: "More info" → "Run anyway".)

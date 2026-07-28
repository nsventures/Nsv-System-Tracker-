# Auto-Update — How Releases Reach the Fleet

The app uses `electron-updater`: an installed build checks a **GitHub Release**
for a newer version, downloads it in the background, and installs it on the next
app quit/restart. The repo is public, so no tokens or auth are involved.

- Repo checked: `nsventures/Nsv-System-Tracker-`
- Update check: at startup, then every 6 hours (`AppUpdater` in `src/main/main.ts`)
- A downloaded update installs on the **next app quit/restart** — for a
  background tracker that usually means the next reboot or log-off. It never
  forces a reboot.

---

## What auto-updates, per platform

| Platform | Auto-updates? | Notes |
| --- | --- | --- |
| **Windows (NSIS)** | ✅ Yes | Works even though the build is unsigned (first *manual* install shows a SmartScreen warning; updates after that are silent). |
| **Linux — AppImage** | ✅ Yes | The recommended Linux deployment. |
| **Linux — .deb** | ❌ No | A `.deb` is owned by apt/dpkg and cannot self-update. Requires the one-time migration below. |
| **macOS** | ❌ No | Auto-update needs a signed + notarized app. The DMG is published unsigned for manual install only, until an Apple Developer ID cert exists. |

---

## Cutting a release

1. Bump the version in **`release/app/package.json`** (e.g. `1.0.0` → `1.0.1`).
   This is the version electron-builder stamps into the installers and the
   `latest*.yml` metadata.
2. Commit and tag:
   ```bash
   git commit -am "Release 1.0.1"
   git tag v1.0.1
   git push origin main --tags
   ```
3. The tag triggers `.github/workflows/release.yml`, which builds all three
   platforms and uploads them to a GitHub Release, along with `latest.yml`
   (Windows), `latest-linux.yml`, and `latest-mac.yml`.
4. By default the release is created as a **draft**. Open it on the
   **Releases** page, confirm the artifacts are attached, then click
   **Publish release**.
5. Within a few hours, Windows and Linux-AppImage machines download and (on
   their next restart) install 1.0.1.

> **Draft is the safety gate.** The fleet does not see the release until you
> click Publish, so a bad build can't reach anyone. To skip the gate and
> publish automatically on every tag, add `"releaseType": "release"` under
> `build.publish` in `package.json`.

> **Tag and version must match.** `git tag v1.0.1` ↔ `release/app/package.json`
> version `1.0.1`. electron-updater compares the installed version against the
> metadata's version, so a mismatch means the update is missed or misnamed.

---

## One-time Linux migration: .deb → AppImage

Machines currently run the `.deb`, which cannot self-update. Each Linux machine
needs a single switch to the AppImage; after that it auto-updates like Windows.

```bash
# 1. Remove the deb
sudo apt remove --purge ns-ventures

# 2. Download NSVentures-<version>-linux-x86_64.AppImage from the Release,
#    put it somewhere stable (a per-user location it can overwrite on update):
mkdir -p ~/Applications
mv ~/Downloads/NSVentures-*-linux-x86_64.AppImage ~/Applications/
chmod +x ~/Applications/NSVentures-*.AppImage

# 3. Launch it once
~/Applications/NSVentures-*.AppImage
```

Autostart is already handled for the AppImage (`$APPIMAGE` in `src/main/main.ts`).
From this point the machine self-updates from published Releases.

> AppImage self-update overwrites the AppImage file in place, so it must live
> somewhere the running user can write (a home-directory path like
> `~/Applications`, **not** `/opt` or another root-owned location).

---

## Verifying an update happened

The update lifecycle is written to `main.log`:

- Windows: `%APPDATA%\NS Ventures\logs\main.log`
- Linux: `~/.config/NS Ventures/logs/main.log`

Look for `[updater]` lines: `Checking for update…`, `Update available: 1.0.1`,
`Update … downloaded; installs on next quit/restart`, or `Update check skipped`
(expected on a `.deb` or unpackaged run).

---

## Still manual

- **macOS** — until a Developer ID certificate is added (then CI needs
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_ID_PASS`, `APPLE_TEAM_ID`,
  and `mac.notarize` set to `true`), Mac users install the DMG by hand.
- **Windows first install** — unsigned, so the very first install shows a
  SmartScreen prompt ("More info" → "Run anyway"). Subsequent auto-updates are
  silent. Code signing removes the prompt.

# Install the audio-merge fork on another Linux machine

This guide installs LucasTakanori's `feature/merge-audio` branch, including
automatic merging in Voice Clone and the standalone Tools > Merge audio pane.
It runs Electron from the checkout with Bun. The app-menu shortcut opens a
terminal for logs and keeps it open after the app exits so errors remain visible.

## 1. Prepare the machine

Install Git, Bash, Node.js, Bun and uv using your distro's package manager or
your existing toolchain manager. Install FFmpeg, including FFprobe, for audio
merging (or install the app-managed tools through Settings > Audio tools).
Use Bun **1.4.2**, as pinned by this branch's root `package.json`.
You need a Linux graphical desktop and enough disk space for the Python
environment and any voice models you choose to download.

On Omarchy, if you already use mise, you can install the runtime tools with:

```bash
mise use --global bun@1.4.2 uv node@lts
```

Reopen the terminal after installing tools, then verify:

```bash
git --version
node --version
bun --version
uv --version
ffmpeg -version
ffprobe -version
```

If pacman reports a package URL returning 404, that transaction failed. Resolve
the distro's mirror/update issue before retrying, or use the toolchain manager
you already have. A working Bun/uv installation through mise needs no second
installation through pacman.

## 2. Clone this specific branch and prepare its dependencies

```bash
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone --branch feature/merge-audio https://github.com/LucasTakanori/VoiceStudio.git
cd VoiceStudio
bun install
bun run setup:api
```

Wait for setup to finish successfully. It can download several GB of Python/GPU
dependencies. Do not copy `.venv` or `node_modules` from the other machine;
these must be installed for the new host. Voices, settings and downloaded
models are separate from the Git repository and are not transferred by cloning.

Run a first launch from this terminal:

```bash
bash scripts/launch-with-logs.sh
```

The terminal shows Electron and backend startup logs. Leave it open while using
VoiceStudio. When the app exits, press Enter to close the terminal.

## 3. Add an app-menu shortcut with a visible terminal

From the repository root, run this once. It writes a separate user-level entry
named **VoiceStudio (audio merge)** and records this machine's checkout path.

```bash
mkdir -p "$HOME/.local/share/applications"
studio_checkout="$(pwd)"
cat > "$HOME/.local/share/applications/voicestudio-audio-merge.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VoiceStudio (audio merge)
Comment=Voice cloning with automatic reference merging and visible logs
Exec=/usr/bin/bash -l "$studio_checkout/scripts/launch-with-logs.sh"
Icon=$studio_checkout/docs/logo.png
Terminal=true
StartupNotify=true
StartupWMClass=VoiceStudio
Categories=AudioVideo;
EOF
```

Open your app launcher and search for **VoiceStudio (audio merge)**. The login
shell loads your normal toolchain PATH. If the checkout is moved, rerun the
shortcut block from its new location. Use a normal checkout path without shell
metacharacters; `~/Projects/VoiceStudio` is the recommended location.

In Voice Clone, select or drop up to 20 clips of the same speaker together.
They merge automatically in the order supplied by the file picker. Combined
clone references must be 75 seconds or shorter; the selected engine may use
only a shorter reference window. Tools > Merge audio lets you reorder clips
manually and export a WAV.

## 4. Update this installation

Close VoiceStudio first. In the checkout on the other machine:

```bash
git switch feature/merge-audio
git pull --ff-only origin feature/merge-audio
bun install
bun run setup:api
```

Reopen the app-menu entry. If Git reports local edits or divergent history, keep
those edits and resolve them before updating; do not reset the checkout blindly.

## Startup problems encountered on our Linux installation

- **Electron runtime missing:** from the repository root, run
  `node electron/node_modules/electron/install.js`, then launch again.
- **Python environment missing or incomplete:** run `bun run setup:api` and
  inspect the terminal for the underlying error.
- **CTranslate2: cannot enable executable stack:** run the project's built-in
  repair once, then relaunch:

  ```bash
  PYTHONPATH=backend .venv/bin/python -c 'from core.execstack import ensure_ctranslate2_loadable; ok, detail = ensure_ctranslate2_loadable(); print(detail); raise SystemExit(0 if ok else 1)'
  ```

  This clears an unnecessary executable-stack flag in the installed library;
  it does not weaken system security settings. A dependency reinstall can
  replace the repaired library, in which case repeat the repair.
- **CUDA out of memory during generation:** use Flush > Unload all + flush and
  retry. If GPU memory is still insufficient, choose CPU under Settings >
  Compute device and restart VoiceStudio. CPU generation is slower. Audio
  merging itself uses FFmpeg and does not need GPU memory.

This is a source installation, not a newly published AppImage. The shortcut
runs the code in this checkout, so pulling the branch updates what it launches.

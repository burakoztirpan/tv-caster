# TV Caster

Play the video from any web page you open on your phone **in your TV's own player**. This is not screen mirroring: the TV pulls the stream from a computer at home, so your phone stays free (you can lock it or use other apps).

It runs on a computer that stays on at home (a Mac mini, an old laptop…). Nothing needs to be installed on the TV; it works with almost any TV that supports DLNA (Samsung, LG, Sony, Philips…). Developed and tested with a Samsung QE55Q67B (2022, Tizen).

## Features

- **Give it a page link, it finds the video.** Opens the page in a real browser (Playwright/Chromium), blocks ads and pop-ups, presses play when needed, and finds the video URL (HLS `.m3u8` / `.mp4`) in network traffic and page source. No site-specific code; it works with generic rules and falls back to [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- **Streams in a format the TV accepts.** The video is relayed to the TV through the computer with the headers the site expects (Referer, Cookie). If audio is a separate rendition, ffmpeg merges it without re-encoding (`-c copy`).
- **Resilient.** Stalled segments are timed out and retried, upcoming segments are prefetched, and if the TV's player stops on its own, playback resumes where it left off.
- **Control panel.** A single mobile page: progress bar, ±10 s / 30 s / 1 min / 5 min / 15 min skips, pause, volume, mute.
- **TV shows.** Finds the other seasons and episodes and plays any of them with one tap; if no list is found, enter a season/episode number manually.
- **Recently watched.** Remembers the show, episode and minute you stopped at ("Resume 23:14", "Next episode"). Stored on the computer, so every device sees the same list.

## Supported TVs

The TV needs a **DLNA/UPnP media renderer**. No app is installed on the TV.

| TV | Status |
|---|---|
| Samsung (Tizen, 2016 and later) | ✅ Tested with QE55Q67B (2022) |
| LG (webOS), Sony Bravia, Philips, Panasonic | Untested; they ship DLNA renderers and should work |
| Android TV / Google TV | Depends on the model: without a built-in DLNA renderer, install a DLNA receiver app such as BubbleUPnP on the TV |
| Apple TV, Fire TV | ❌ No DLNA support |

The TV must be on the **same home network** as the computer. If it isn't discovered automatically, set `TV_IP` in `.env`.

## Installation

Requirements: Node.js 22.6+ (24 recommended), ffmpeg, yt-dlp and Playwright's Chromium. The computer running the server must stay on while you watch.

### macOS

```bash
brew install node ffmpeg yt-dlp
git clone https://github.com/burakoztirpan/tv-caster.git && cd tv-caster
npm install
npx playwright install chromium
cp .env.example .env    # optional settings
npm start
```

### Windows (untested)

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp Git.Git
# open a new PowerShell window so PATH is refreshed
git clone https://github.com/burakoztirpan/tv-caster.git; cd tv-caster
npm install
npx playwright install chromium
copy .env.example .env
npm start
```

- On first run, Windows Firewall asks about Node.js: allow it on **private networks**, otherwise the TV can't reach the computer.
- With virtual network adapters (Hyper-V, WSL, VPN) the server may pick the wrong IP. If the address in the startup log isn't your home network IP, set `HOST_IP` in `.env`.
- To start automatically when you log in (adjust the folder path):

  ```powershell
  schtasks /Create /SC ONLOGON /TN "TV Caster" /TR "cmd /c cd /d C:\tv-caster && npm start >> %USERPROFILE%\tv-caster.log 2>&1"
  ```

### Linux

Install Node 22.6+, ffmpeg and yt-dlp with your package manager; the `git clone` and `npm` steps are the same as on macOS. Use a systemd service to keep it running.

### First run

On startup the log prints `[server] http://<host-ip>:8787`; that address is the control panel. Open it on your phone. On iPhone, Safari → Share → **Add to Home Screen** makes it feel like an app.

**The TV may ask for permission on the first connection.** Samsung shows an allow/deny prompt the first time. If you missed it: Settings → General → External Device Manager → Device Connection Manager → Device List → set the computer to **Allow**.

### Settings (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | |
| `TV_IP` | discovered via SSDP | Set manually if the TV isn't found |
| `HOST_IP` | first LAN IPv4 | Address the TV uses to reach the computer |
| `HLS_MODE` | `auto` | `auto`: send the playlist straight to the TV (native seeking) unless audio is a separate rendition, then merge with ffmpeg. `hls` / `ts` force one path |
| `BLOCKLIST` | `blocklist.txt` | Ad domains to block |
| `EXTRACT_TIMEOUT` | `25000` | Video search time (ms) |
| `HEADLESS` | `1` | `0`: show the browser for debugging |
| `DEBUG` | – | Log TV requests and stream stats |

### Start on boot on macOS (launchd)

```bash
sed -e "s#__DIR__#$PWD#g" -e "s#__NODE__#$(which node)#g" -e "s#__HOME__#$HOME#g" \
  com.tvcaster.plist > ~/Library/LaunchAgents/com.tvcaster.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tvcaster.plist
```

- Restart (after code changes): `launchctl kickstart -k gui/$(id -u)/com.tvcaster`
- Remove: `launchctl bootout gui/$(id -u)/com.tvcaster`
- Log: `tail -f ~/Library/Logs/tv-caster.log`
- The agent starts when the user logs in; to have it running after a reboot, enable automatic login. The Node path is written into the plist; rerun the command if you change Node versions.

## Sending from your phone

**Bookmarklet (recommended).** Bookmark any page, name it `Play on TV`, and replace its address with the following (replace `<host>` with the server computer's network name, e.g. `macmini`, or use its IP):

```
javascript:location.href='http://<host>.local:8787/?cast='+encodeURIComponent(location.href)
```

On a page with a video, open this bookmark: the panel opens and the video starts on the TV. In Safari run it from the bookmarks menu; in Chrome type `Play on TV` in the address bar and pick the bookmark from the suggestions.

**iOS Shortcuts (alternative).** Adds "Play on TV" to the share sheet. On some setups the request doesn't reach the computer; if so, use the bookmarklet.

1. **Shortcuts** → **+** → tap the name at the top and call it **Play on TV**.
2. Tap **ⓘ** → enable **Show in Share Sheet**; keep only **URLs** and **Safari web pages** as input types. If the input block at the top says "Nowhere", choose **Share Sheet**.
3. Search `URL` → add **Get Contents of URL**:
   - URL: `http://<host>.local:8787/cast` (or the computer's IP)
   - Method **POST**, Request Body **JSON**, **Add new field → Text**: key `url`, value **Shortcut Input**
4. (Optional) Search `show` → add **Show Alert**; it displays the server's response, handy for troubleshooting.
5. Use it: on a page with a video, **Share** → **Play on TV**. If it's not listed, add it via **Edit Actions** at the bottom of the share sheet. Allow access to devices on your local network if asked.

**Manually.** Paste the page link into the box on the panel.

## API

| | |
|---|---|
| `POST /cast` `{"url": "...", "resume": false}` | A page, or a direct `.m3u8`/`.mp4`; `resume`: continue where you left off |
| `POST /play`, `/pause`, `/stop` | |
| `POST /seek?t=600`, `/seek?d=-30` | absolute / relative seconds |
| `POST /volume?v=20`, `/volume?d=5`, `/mute?on=1` | |
| `GET /status` | TV state, position, duration, volume |
| `GET /history`, `POST /history/remove?key=` | recently watched |
| `GET /episodes?key=`, `POST /play-episode?key=&season=&episode=` | season/episode list, play an episode |

## How it works

```
Phone ──link──▶ Computer (Node)
                 ├─ extractor.ts  Playwright: opens the page, blocks ads, finds the video URL and its headers (fallback: yt-dlp)
                 ├─ proxy.ts      fetches with the right headers, rewrites HLS playlists,
                 │                prefetches/retries segments, ffmpeg -c copy → MPEG-TS when needed
                 ├─ dlna.ts       finds the TV via SSDP; SetAVTransportURI / Play / Pause / Seek / Volume
                 ├─ episodes.ts   finds a show's seasons and episodes
                 └─ history.ts    recently watched and resume position (data/history.json)
                                        │
                                        ▼
                                 the TV's own player
```

Tests: `npm test`. Type check: `npm run check`.

## Limitations

- DRM-protected content (Netflix, Disney+, etc.) does not work and won't be supported.
- Some sites show a "are you human" check; automatic detection may fail there (`HEADLESS=0` lets you pass it once by hand).
- For streams merged with ffmpeg, seeking restarts the stream at the new position (the TV goes black for a few seconds).
- Video detection rules may need updates as sites change.

## Security

- The server is meant for your **home network only** and has no login: anyone on the same network can control the TV. Don't port-forward it or expose it to the internet.
- Control requests must be JSON (`Content-Type: application/json`), so other websites you visit can't silently send commands to it from your browser (CSRF).
- The stream proxy only fetches hosts that the detected video points to; it can't be used as an open proxy.

## Disclaimer

This project is a general-purpose tool for watching videos you can access on the web on your own TV. It is not affiliated with any website and does not host or distribute any content. You are responsible for what you watch and for complying with copyright and applicable law.

## License

MIT

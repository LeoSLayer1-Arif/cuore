# CUORE · web app

CUORE measures **heart rate, breathing and blinks from an ordinary webcam**, learns your personal baseline, and shows how you compare with it. It runs entirely on your own computer: the camera, the analysis and every reading stay there.

**Website:** [heartware.health](https://heartware.health/) · **Setup guide:** [heartware.health/run.html](https://heartware.health/run.html)

> [!WARNING]
> CUORE is a hackathon prototype, not a medical device. Don't use its readings to diagnose, treat or make health decisions.

This is the **`web-ui` branch**: a browser app served by a small local Python server, plus the product website. The original desktop app (an OpenCV window, `app.py`) still runs here too; see [Desktop window and tools](#desktop-window-and-tools). This branch and `main` have separate histories.

## Quick start (macOS, Linux, Windows)

You need Python 3.12, a webcam and about 2 GB of disk space. On a Mac without Python 3.12: `brew install python@3.12`.

```bash
git clone -b web-ui https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt      # Windows: venv\Scripts\pip
venv/bin/python server.py                     # Windows: venv\Scripts\python
```

Open **http://127.0.0.1:5001/app**, allow the camera, pick a session length and sit facing a light. The first start takes about 30 seconds while the heart-rate model loads. Everything it needs is included, so nothing is downloaded while it runs.

MediaPipe needs `opencv-contrib-python` and open-rppg needs `opencv-python`. Both install into the same `cv2` folder, so `requirements.txt` pins them to the same version. If you install OpenCV yourself, keep the two versions equal.

Port 5000 is used by AirPlay on macOS, so CUORE uses 5001. Another port: `--port 5002`.

### From a phone (opt-in)

```bash
venv/bin/python server.py --lan
```

This prints an `https://…` address and an 8-character pairing code. Open the address on a phone on the **same network** (a phone hotspot works when public Wi-Fi blocks devices from seeing each other), accept the certificate warning (the certificate was made on your computer for that address), and enter the code. The phone's front camera is used; its video goes to your computer over your Wi-Fi and nowhere else.

### Desktop window and tools

```bash
venv/bin/python find_cameras.py                         # shows each camera's picture and its number
venv/bin/python server.py --source webcam --camera 1    # Python opens that camera instead of the browser
venv/bin/python app.py --camera 1                       # the original OpenCV desktop window
venv/bin/python app.py --record session.csv             # also saves per-frame signals; press m to mark a moment
venv/bin/python replay.py session.csv                   # re-runs vitals.py on a recording
```

`replay.py` re-runs this project's own skin-colour heart rate (`--hr colour`) and the breathing estimator on a recording, so you can change filters or thresholds and re-check them without recording again. It doesn't re-run the open-rppg model.

## What it measures

| Measurement | How | When it's ready | When it's trusted |
|---|---|---|---|
| **Heart rate** | rPPG: a neural model ([open-rppg](https://github.com/KegangWangCCNU/open-rppg), `FacePhys.rlap`) recovers the pulse wave from skin-colour changes | ≈ 10 s | Heart signal quality (SQI) **above 0.22** |
| **Breathing** | Dense optical flow (Farnebäck) on the chest and shoulders, 5.1–36 breaths/min; head motion only as a fallback | 20 s | From chest motion, breathing peak ≥ −3 dB above noise. Head-motion readings are provisional |
| **Blinks** | Eye aspect ratio from 478 MediaPipe face landmarks | 10 s (provisional) | A full 60 s counted |
| **Composure** | Comparison with your own baselines, never a stress diagnosis | ≈ 2 min | *Calm* needs two or more measurements compared with a ready baseline; a large blink drop alone is enough for *elevated* |

Every value is shown as **reliable**, **provisional** (dimmed, marked ≈, never averaged) or **unavailable** (blank, with the reason).

- **Session average BPM** uses only reliable heart-rate readings captured **after the first 10 seconds** of the session. Those first 10 s are calibration; live BPM is shown throughout.
- **Breathing** comes from chest motion whenever the chest signal passes its check. Head motion is used only when it doesn't, usually because the shoulders are out of view; those readings are provisional. Each reading covers the last 30 s, and the reading clears 1–2 s after your face leaves the frame.
- **Personal baselines:** each measurement learns its own from its reliable readings, once 60 s have passed since its first valid reading and at least 30 s of valid readings were collected.
- **Composure** compares only reliable readings with the ready baselines. It is *elevated* when blinks fall below 60 % of baseline (and at least 3/min lower), which is enough on its own, or when two of these happen together: heart rate +15 %, breathing +25 %, fewer blinks. It is *calm* only when at least two measurements could be compared; otherwise it shows *insufficient data*.
- **45-second quick read** (experimental): heart rate and breathing only; it is too short for baselines or composure, and says so.

## The app

- **Live:** session average and live heart rate, signal quality, composure with its basis, the breathing wave, and a 1-minute guided breathing exercise.
- **Summary:** a session report with six headline metrics, trend charts (provisional seconds dotted, gaps left as gaps), heart-signal quality, data availability, plain-language findings and moments.
- **Download Report:** PDF, CSV (one row per second) or PNG, generated in the browser. Nothing is uploaded.
- **Phones:** front camera, portrait layout, bottom tab bar, pause and resume when the app goes to the background. Can be added to the home screen.
- **Diagnostics:** add `?diag` to the address for a measurement panel with CSV export (numbers only, never images).

## Privacy and security

- The server listens on **127.0.0.1** only. With `--lan` it listens on your home-network address over https, and every device must enter the pairing code (rate-limited; the session cookie is HttpOnly, Secure, SameSite=Strict).
- Video frames are processed in memory and never written to disk.
- No accounts, no cloud, no analytics. A strict Content-Security-Policy blocks loading anything from elsewhere.
- Every request is checked for the right host (DNS-rebinding protection), and state-changing requests need the same origin plus a custom header (CSRF protection).

## Tests

```bash
venv/bin/python -m pytest
```

`test_server.py` covers baselines, composure, the 0.22 signal-quality boundary, the 10 s calibration rule and phone-mode security. `test_vitals.py` checks the signal processing with synthetic signals.

## Project structure

| Path | Purpose |
|---|---|
| `server.py` | Flask server: runs the measurement loop, baselines, composure, phone mode |
| `app.py`, `vitals.py` | The desktop window (`app.py`) and the measurement code the server shares with it (rPPG wrapper, breathing, blinks) |
| `find_cameras.py` | Shows a picture from each connected camera so you can pick the `--camera` number |
| `replay.py` | Re-runs `vitals.py` on a recording made with `app.py --record` |
| `face_landmarker.task` | MediaPipe Face Landmarker model (float16 v1, Apache-2.0) |
| `web/index.html`, `app.js`, `app.css` | The measurement app (`/app`) |
| `web/report.js` | PDF, PNG and CSV report export |
| `web/home.html`, `home.css`, `home.js` | Product homepage (`/`) |
| `web/run.html` | Setup guide page |
| `docs/` | The published website (GitHub Pages, heartware.health). Generated: don't edit by hand |
| `tools/build_site.py` | Builds `docs/` from `web/` |
| `test_server.py`, `test_vitals.py` | Tests |
| `requirements.txt` | Pinned direct dependencies; `requirements.lock` pins everything |
| `LICENSE` | MIT License for this project's code |

### Updating the website

Edit `web/home.html` or `web/run.html` (or their CSS/JS), then:

```bash
python3 tools/build_site.py
```

Commit and push `docs/`; GitHub Pages republishes heartware.health within a minute or two.

## Limitations

- Not clinically validated. Check against a fingertip pulse oximeter if accuracy matters.
- Dim or flickering light, a bright window behind you, movement and talking all reduce accuracy.
- rPPG can be less accurate on darker skin tones, where the colour signal is weaker; CUORE hasn't been tested across skin tones.
- Breathing below about 5 breaths/min isn't measured. With the shoulders out of view, breathing comes from head motion, which is much less accurate; it's shown as provisional.
- One face at a time, one session at a time per server.

## Credits and licences

The code in this repository is released under the MIT License (see `LICENSE`). The pretrained models and the MediaPipe model keep their own licences, listed below.

- [open-rppg](https://github.com/KegangWangCCNU/open-rppg) (MIT). Its pretrained models are the property of their authors and follow the terms of their original publications.
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (Apache-2.0).
- W. Verkruysse, L. O. Svaasand, J. S. Nelson, "Remote plethysmographic imaging using ambient light," *Optics Express*, 2008.
- G. Farnebäck, "Two-frame motion estimation based on polynomial expansion," SCIA, 2003.
- T. Soukupová, J. Čech, "Real-Time Eye Blink Detection using Facial Landmarks," CVWW, 2016.

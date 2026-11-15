# Cuore

Cuore is a contact-free vital-signs prototype that estimates heart rate, average heart rate, breathing rate, and blink rate from a camera feed. It uses remote photoplethysmography (rPPG), facial landmarks, and motion analysis to turn an ordinary webcam or a selected screen region into a live monitoring dashboard.

> [!WARNING]
> Cuore is a hackathon prototype, not a medical device. Do not use its measurements to diagnose, treat, or make health decisions.

## What is available on `main`

The current `main` branch runs as a local OpenCV desktop application. It includes:

- Live heart-rate estimation using an Open-rppg model by default.
- An optional colour-based POS heart-rate estimator.
- A configurable average-BPM session with calibration and progress tracking.
- Breathing-rate estimation from chest and head motion.
- Blink-rate estimation from eye landmarks.
- Live pulse and respiration graphs.
- Face, skin-region, chest, head, and neck tracking overlays.
- Webcam and screen-region input.
- Camera and processing FPS diagnostics.

A browser dashboard is under active development but is **not merged into `main`**. See [Web development status](#web-development-status).

## How it works

```text
Webcam or screen region
        |
        v
Latest-frame capture and timestamping
        |
        +--> MediaPipe Face Landmarker (one face, 478 landmarks)
        |       |--> forehead and cheek regions
        |       |--> eye aspect ratio
        |       `--> head/chest tracking regions
        |
        +--> Open-rppg model or colour/POS pulse extraction --> BPM
        +--> Chest/head motion filtering -------------------> breaths/min
        `--> Eye closure detection -------------------------> blinks/min
                                |
                                v
                  Average monitor and OpenCV dashboard
```

### Heart rate

The default `rppg` mode sends RGB frames to an Open-rppg model and requests heart rate over a rolling 10-second window. The default model is `FacePhys.rlap`. The dashboard also displays the model's signal quality index (SQI).

The optional `colour` mode samples the forehead and cheeks, resamples the measurements to a regular 30 Hz timeline, applies the Plane-Orthogonal-to-Skin (POS) method, and searches for a pulse between 45 and 180 BPM.

### Average BPM

An average session is based on valid one-per-second readings rather than fixed wall-clock time:

1. Cuore collects 10 valid calibration readings and excludes them from the average.
2. It records `--avg-seconds` valid readings, 60 by default.
3. Missing face or BPM data pauses progress.
4. The completed average remains visible until you press `r`.

The running average currently accepts every available BPM. In default `rppg` mode, the SQI label is informational and weak-SQI values are not automatically excluded.

### Breathing and blinks

Cuore compares motion from the chest and head and uses the cleaner signal for breathing rate. Breathing needs about 15 seconds of usable data and works best when the shoulders are visible. The search range is 6 to 36 breaths per minute.

Blink detection uses the eye aspect ratio and learns an open-eye level for the current face. The blink-rate display needs at least 10 seconds of observations.

## Requirements

- Python 3.10 or 3.11 is recommended. The repository does not currently enforce a Python version.
- A GUI-capable desktop environment for the OpenCV window.
- A webcam supported by OpenCV, or a capturable screen region.
- OS camera and screen-recording permissions where applicable.
- At least 15 processed frames per second is recommended by the dashboard.

The MediaPipe face-landmark model is included as `face_landmarker.task`. If the file is missing, Cuore attempts to download it when the application starts. Open-rppg may also obtain model assets outside this repository.

## Installation

### macOS and Linux

```bash
git clone https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Windows PowerShell

```powershell
git clone https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Run Cuore

Start with the default webcam and Open-rppg model:

```bash
python app.py
```

Find available camera indices:

```bash
python find_cameras.py
```

Use another camera:

```bash
python app.py --camera 1
```

Use the colour/POS heart-rate estimator:

```bash
python app.py --hr colour
```

Record a 90-reading average after calibration:

```bash
python app.py --avg-seconds 90
```

Capture a screen region, such as a participant's video tile:

```bash
python app.py --screen 100 100 640 480
```

Keep the Cuore window outside the selected region to avoid capturing its own dashboard.

### Command-line options

| Option | Description | Default |
|---|---|---|
| `--camera INDEX` | OpenCV camera index | `0` |
| `--width WIDTH` | Requested camera width; use with `--height` | Camera default |
| `--height HEIGHT` | Requested camera height; use with `--width` | Camera default |
| `--backend auto\|dshow\|msmf` | Camera backend; explicit choices apply to Windows | `auto` |
| `--screen LEFT TOP WIDTH HEIGHT` | Capture a screen rectangle instead of a webcam | Disabled |
| `--hr rppg\|colour` | Heart-rate implementation | `rppg` |
| `--rppg-model NAME` | Open-rppg model name | `FacePhys.rlap` |
| `--avg-seconds SECONDS` | Number of valid readings in the average; minimum 10 | `60` |

Examples of model names recognized by the installed Open-rppg package may include `FacePhys.rlap`, `ME-flow.rlap`, and `PhysFormer.pure`. If a name is unsupported, Cuore prints the models available in the installed package.

### Keyboard controls

| Key | Action |
|---|---|
| `r` | Reset and restart the average-BPM session |
| `q` | Quit |
| `Esc` | Quit |

Closing the OpenCV window also exits the application.

## Getting a cleaner signal

- Face the camera directly and keep your head still.
- Use steady, frontal lighting. Avoid backlighting and flickering lights.
- Keep the forehead and cheeks unobstructed.
- Move far enough from the camera for your shoulders to remain visible.
- Close other camera-heavy or CPU-heavy applications.
- Prefer a direct webcam feed over compressed video-call footage.
- Allow the initial signal windows to fill before judging a reading.

## Troubleshooting

| Problem | What to try |
|---|---|
| Camera does not open | Close other camera applications, check OS permissions, run `python find_cameras.py`, and try another `--camera` index. |
| Camera opens but frames are black | Remove `--width` and `--height`; the camera may not support the requested resolution. |
| Camera is slow on Windows | Try `--backend dshow` or `--backend msmf`. |
| BPM stays unavailable or unstable | Improve frontal lighting, remain still, and wait for the heart-rate window to fill. |
| Dashboard reports low FPS | Lower the requested camera resolution and close competing processes. |
| Breathing rate stays unavailable | Move back until the shoulders are visible and remain still for at least 15 seconds. |
| MediaPipe model is missing | Restore `face_landmarker.task` or allow access to the configured model download URL. |
| OpenCV packages conflict | Remove conflicting `opencv-python` and `opencv-contrib-python` installations, then reinstall the environment from `requirements.txt`. |
| Screen mode captures recursively | Move the Cuore window outside the rectangle passed to `--screen`. |

## Web development status

Several browser designs were built during the hackathon, but none is part of `main` yet:

| Work | Architecture | Status |
|---|---|---|
| [`web-frontend` / PR #4](https://github.com/LeoSLayer1-Arif/cuore/pull/4) | FastAPI dashboard using the laptop camera, REST controls, server-sent events, and an MJPEG preview | Open PR |
| [`feature/average-bpm-dashboard` / PR #2](https://github.com/LeoSLayer1-Arif/cuore/pull/2) | Phone camera sends frames to a Python backend over an HTTPS WebSocket | Open draft PR |
| [`feature/web-dashboard` / PR #3](https://github.com/LeoSLayer1-Arif/cuore/pull/3) | Flask dashboard using the laptop camera | Open PR |
| [`web-ui`](https://github.com/LeoSLayer1-Arif/cuore/tree/web-ui) | Larger alternate web prototype with separate Git history | Not merged |

The closest browser equivalent to the current desktop application is PR #4. To evaluate that branch locally:

```bash
git switch web-frontend
python -m pip install -r requirements.txt
python server.py
```

Then open `http://127.0.0.1:8000`. The branch keeps camera access on the laptop and starts capture only after the browser requests it. Its server has no authentication, so keep the default loopback binding unless you understand the privacy implications of exposing a live camera feed on a network.

The phone-camera draft in PR #2 uses a different protocol and setup. It requires HTTPS for camera access from another device and is still marked work in progress.

## Repository layout

| Path | Purpose |
|---|---|
| `app.py` | Capture sources, MediaPipe integration, Open-rppg wrapper, averaging, overlays, and desktop entry point |
| `vitals.py` | Colour/POS heart-rate processing, respiration processing, blink counting, filtering, and signal helpers |
| `face_landmarker.task` | Bundled MediaPipe Face Landmarker model |
| `find_cameras.py` | Camera-index discovery utility |
| `requirements.txt` | Python runtime dependencies |
| `test_vitals.py` | Legacy synthetic checks; currently out of sync with the latest `vitals.py` interfaces |
| `READMElmao.md` | Reference documentation for the external Open-rppg package, not Cuore's application README |

## Privacy, limitations, and responsible use

- `main` processes frames locally and does not intentionally upload or persist measurements.
- Screen capture and experimental web branches can expose other people's images. Obtain consent before measuring anyone.
- Motion, lighting, camera auto-exposure, compression, and low frame rate can distort rPPG measurements.
- Performance across skin tones, cameras, environments, and hardware has not been validated by this repository.
- Only one face is processed.
- The colour heart-rate mode searches 45 to 180 BPM; respiration searches 6 to 36 breaths per minute.
- Cuore has no clinical validation, accuracy guarantee, persistent storage, or report export on `main`.
- No license file is currently included in the repository.

## References

- Wang, Wenjin, Albertus C. den Brinker, Sander Stuijk, and Gerard de Haan. “Algorithmic Principles of Remote PPG.” *IEEE Transactions on Biomedical Engineering*, 2017.
- Soukupová, Tereza, and Jan Čech. “Real-Time Eye Blink Detection Using Facial Landmarks.” 2016.
- [MediaPipe Face Landmarker documentation](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)

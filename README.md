# Cuore

Cuore measures heart rate, breathing rate and blink rate from an ordinary webcam, with no sensors touching the body. It uses remote photoplethysmography (rPPG): each heartbeat changes how much light facial skin absorbs, and a camera can pick up that change over many frames.

**Website:** [heartware.health](https://heartware.health/)

> [!WARNING]
> Cuore is a hackathon prototype, not a medical device. Do not use its readings to diagnose, treat or make health decisions.

## Where to find each part

| Part | Location | How it runs |
|---|---|---|
| Desktop app | `main` branch (this page) | `python app.py` opens an OpenCV window with a live dashboard |
| Web app | [`web-ui` branch](https://github.com/LeoSLayer1-Arif/cuore/tree/web-ui) | `python server.py` serves a browser dashboard on your own computer |
| Website | [`web-ui` branch, `docs/`](https://github.com/LeoSLayer1-Arif/cuore/tree/web-ui/docs) | Static site hosted on GitHub Pages at [heartware.health](https://heartware.health/) |

Both apps use the same measurement code. The web app is described in [Web app](#web-app-web-ui-branch).

## Features

- **Live heart rate** from a deep-learning rPPG model ([open-rppg](https://github.com/KegangWangCCNU/open-rppg), `FacePhys.rlap` by default), with a signal-quality score.
- **Optional colour-based heart rate** using the POS algorithm, implemented in this repository.
- **Average BPM**: a 10-second calibration, then an average of 60 one-second readings by default.
- **Breathing rate** from chest and shoulder motion, with head motion as a fallback.
- **Blink rate** from eye landmarks, with a threshold that adapts to each person.
- **Live pulse and breathing graphs**, face and chest tracking overlays, and camera and processing FPS.
- **Webcam or screen capture**, so it can also read a person in a video-call tile.

## How it works

```text
Webcam or screen region
        |
        v
Background capture thread (timestamps each frame on arrival)
        |
        v
MediaPipe Face Landmarker: 478 points on one face
        |
        +--> Heart rate:  open-rppg neural model (default)
        |                 or forehead + cheek colour -> POS -> spectrum (--hr colour)
        +--> Breathing:   optical flow below the chin (chest) and head position
        +--> Blinks:      eye aspect ratio
        |
        v
Average BPM monitor -> OpenCV dashboard
```

**Heart rate.** In the default mode, every frame goes to an open-rppg model, which reports heart rate over the last 10 seconds once per second, along with a signal quality index (SQI) between 0 and 1. The dashboard reports the signal as good when the SQI is at least 0.5. With `--hr colour`, Cuore instead averages the skin colour of the forehead and both cheeks, extracts a pulse with the Plane-Orthogonal-to-Skin (POS) method, and finds the strongest frequency between 45 and 180 BPM. It then refines that frequency by timing individual beats.

**Breathing.** Breathing moves the chest more than the head. Cuore tracks vertical motion in a box below the chin using optical flow, and also records head position. It filters both to 6–36 breaths per minute and uses whichever signal has the clearer peak. The first reading takes about 15 seconds.

**Blinks.** The eye aspect ratio (eye height divided by eye width) drops during a blink. Cuore learns each person's open-eye level, and counts a closure of 2 to 15 frames as one blink. The rate is shown after 10 seconds and is averaged over the last minute.

**Motion points.** Magenta points on the forehead, nose and neck come from an experimental motion-based pulse tracker. They are drawn on screen but are not yet used in any reading.

## Average BPM

The average card counts one reading per second while a heart rate is shown.

1. **Calibration (CAL):** the first 10 readings are discarded, because the first values after the heart rate appears are the least stable.
2. **Recording (REC):** the next 60 readings are averaged. Change this with `--avg-seconds`.
3. **Paused:** if the face is lost or there is no reading, the count pauses instead of counting the gap.
4. **Final:** the average is kept on screen until you press `r` to start again.

Because the count only advances on valid readings, a session takes at least 70 seconds after the first heart rate appears. In the default mode, readings with a low SQI are still included in the average.

## Requirements

- Python 3.12. This is the version used to test the setup below and the one the website recommends.
- About 2 GB of disk space for the Python packages.
- A webcam, and permission for your terminal or Python to use it.
- A desktop session that can open windows (the app uses `cv2.imshow`).

The MediaPipe face model (`face_landmarker.task`) is included in the repository, and the open-rppg model weights come with the `open-rppg` package. No other downloads are needed after installation.

## Installation

macOS or Linux:

```bash
git clone https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Windows (PowerShell):

```powershell
git clone https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

On macOS, allow camera access for your terminal app when asked.

## Usage

```bash
python app.py
```

The first start takes a little while as the heart-rate model loads. Sit still, facing a lamp or window, with your shoulders in view.

| Command | What it does |
|---|---|
| `python app.py` | Default webcam and the `FacePhys.rlap` model |
| `python find_cameras.py` | Shows one frame from each camera so you can find its number |
| `python app.py --camera 1` | Uses camera 1 |
| `python app.py --hr colour` | Uses the colour/POS heart-rate method |
| `python app.py --rppg-model ME-flow.rlap` | Uses a different open-rppg model |
| `python app.py --avg-seconds 90` | Averages 90 readings instead of 60 |
| `python app.py --screen 100 100 640 480` | Reads a screen region (left, top, width, height), such as a video-call tile |

### Options

| Option | Description | Default |
|---|---|---|
| `--camera INDEX` | Webcam number | `0` |
| `--width W --height H` | Ask the camera for a specific size; both are needed | Camera's own default |
| `--backend auto\|dshow\|msmf` | Windows camera system: DirectShow or Media Foundation | `auto` |
| `--screen LEFT TOP WIDTH HEIGHT` | Capture a screen region instead of a webcam | Off |
| `--hr rppg\|colour` | Heart-rate method | `rppg` |
| `--rppg-model NAME` | open-rppg model | `FacePhys.rlap` |
| `--avg-seconds N` | Readings in the average, at least 10 | `60` |

Available open-rppg models include `FacePhys.rlap`, `ME-flow.rlap`, `ME-chunk.rlap`, `PhysFormer.pure`, `PhysMamba.rlap`, `RhythmMamba.rlap`, `TSCAN.rlap`, `PhysNet.rlap` and `EfficientPhys.rlap`. An unknown name prints the full list.

### Keys

| Key | Action |
|---|---|
| `r` | Restart the average BPM (calibration included) |
| `q` or `Esc` | Quit |

### Screen mode

To read someone in a video call, pass the pixel position of their tile to `--screen`. Keep the Cuore window outside that region, or it will capture its own dashboard. Video calls compress the image, which weakens the signal, so ask the other person to sit in good light. Get their consent first.

## Tests

The signal-processing code in `vitals.py` can be checked without a camera. The tests feed synthetic signals with a known rate into each estimator:

```bash
python test_vitals.py
```

Expected output:

```text
heart rate   OK: 72.3 BPM (true 72.0)
breathing    OK: 14.9/min (true 15.0, from chest)
blinks       OK: 19.0/min (true 19)
All checks passed.
```

## Web app (`web-ui` branch)

The `web-ui` branch turns Cuore into a browser app that runs on your own computer, with a product homepage and a phone mode. Its code has a separate Git history and has not been merged into `main`.

```bash
git clone -b web-ui https://github.com/LeoSLayer1-Arif/cuore.git cuore-web
cd cuore-web
python3.12 -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python server.py
```

Then open `http://127.0.0.1:5001/app` and allow camera access.

How it differs from the desktop app:

- A Flask server (`server.py`) runs the same measurement code. By default the browser opens the camera and sends timestamped frames to the server on the same computer.
- Each reading is labelled reliable, provisional or unavailable. Heart rate counts as reliable when the SQI is above 0.22, and only reliable readings go into the average.
- The average covers 120 seconds by default, after a 10-second calibration.
- Cuore learns a personal baseline for each measurement, then reports composure compared with that baseline. Composure is a comparison with the user's own readings and is not a stress diagnosis.
- At the end of a session, the app builds a report that can be downloaded as PDF, PNG or CSV. It is generated in the browser and is not uploaded.
- `python server.py --lan` serves HTTPS on the local network, so a phone on the same Wi-Fi can pair with an 8-character code and use its camera.
- `python server.py --source webcam` makes Python open the camera, like the desktop app.

The server listens on `127.0.0.1` only unless `--lan` is used. Run its tests with `python -m pytest`. Full setup steps are on the [Run Cuore page](https://heartware.health/run.html).

## Troubleshooting

| Problem | What to try |
|---|---|
| "Could not open camera" | Close other apps using the camera, check camera permission, run `python find_cameras.py`, then try another `--camera` number. |
| Black frames | Remove `--width` and `--height`. Some cameras give black frames at sizes they don't support. |
| Camera slow to open on Windows | Try `--backend dshow` or `--backend msmf`. |
| Heart rate stays at `--` or the signal is weak | Face a lamp or window, avoid a bright window behind you, keep your whole face in view and hold still. |
| FPS below 15 | Close other apps. Large frames are already shrunk to 640 pixels wide for face tracking. |
| Breathing stays at `--` | Sit back so your shoulders show, and wait at least 15 seconds. |
| `import cv2` errors | MediaPipe installs `opencv-contrib-python`, which can clash with `opencv-python`. Uninstall both, then install only `opencv-contrib-python`. |
| Screen mode shows the dashboard inside itself | Move the Cuore window outside the captured region. |

## Project structure

| File | Purpose |
|---|---|
| `app.py` | Camera and screen capture, face tracking, open-rppg wrapper, breathing and blink inputs, average BPM, dashboard drawing |
| `vitals.py` | Signal processing with NumPy and SciPy only: POS heart rate, breathing rate, blink counting |
| `test_vitals.py` | Synthetic-signal checks for `vitals.py` |
| `find_cameras.py` | Shows each connected camera so you can pick its number |
| `face_landmarker.task` | MediaPipe Face Landmarker model (3.8 MB) |
| `requirements.txt` | Python dependencies |
| `docs/open-rppg-reference.md` | Reference copy of the third-party open-rppg documentation |

## Limitations and privacy

- Cuore is not a medical device and has not been clinically validated. Check readings against a fingertip pulse oximeter if accuracy matters.
- Movement, talking, dim or flickering light, backlighting and video compression all reduce accuracy.
- rPPG can be less accurate on darker skin tones, where the colour signal is weaker. Cuore has not been tested across skin tones.
- Only one face is measured at a time.
- The desktop app processes video in memory on your computer. It does not save video or readings, and it sends nothing over the network.
- Get consent before measuring anyone, especially through screen mode.

## References

- W. Wang, A. C. den Brinker, S. Stuijk and G. de Haan, "Algorithmic Principles of Remote PPG," *IEEE Transactions on Biomedical Engineering*, 2017. (POS algorithm)
- W. Verkruysse, L. O. Svaasand and J. S. Nelson, "Remote plethysmographic imaging using ambient light," *Optics Express*, 2008.
- T. Soukupová and J. Čech, "Real-Time Eye Blink Detection using Facial Landmarks," 2016. (Eye aspect ratio)
- [open-rppg](https://github.com/KegangWangCCNU/open-rppg), the rPPG model library used for the default heart rate.
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)

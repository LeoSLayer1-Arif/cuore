# rPPG Vitals Monitor

Camera-based heart rate, breathing rate and blink rate. It reads the tiny color changes that blood flow causes in facial skin (remote photoplethysmography, rPPG). It works on a webcam or on a region of your screen, such as a Zoom tile.

**Status:** Won Best MedTech Hack at HackUMass XIV. In our informal tests against a fingertip pulse oximeter, the heart rate stayed within 2 BPM of the oximeter and matched it exactly about 90% of the time. It is a screening demo, not a diagnosis, and one should always refer to a medical professional before taking any action.

## Project structure

| File | Purpose |
|---|---|
| `vitals.py` | Signal processing (NumPy/SciPy only, no camera needed) |
| `app.py` | Camera or screen capture, face tracking, on-screen dashboard |
| `test_vitals.py` | Synthetic-signal checks for `vitals.py` |
| `find_cameras.py` | Lists connected cameras so you can pick the right `--camera` number |
| `face_landmarker.task` | MediaPipe face model (downloaded automatically if missing) |
| `requirements.txt` | Dependencies |
| `LICENSE` | MIT License for this project's code |

## How it works

The app has two heart-rate modes, chosen with `--hr`:

- **`--hr rppg` (default).** A pretrained neural network from the [open-rppg](https://github.com/KegangWangCCNU/open-rppg) library finds the face and extracts the pulse signal. The app reads the heart rate from the last 10 seconds of that signal. The default model is `FacePhys.rlap`. Try others with `--rppg-model`.
- **`--hr colour`.** This project's own signal-processing pipeline, described below.

Breathing and blinks are always measured by this app, in both modes.

### Face tracking (both modes)

MediaPipe Face Landmarker places 478 points on the face in every frame. The app uses them to find skin areas (for `--hr colour`), the eyes (for blinks) and the head (for breathing).

### Heart rate from skin color (`--hr colour`)

1. **Pick skin areas.** The forehead and both cheeks have strong blood flow and little hair.
2. **Average the color.** Each frame gives one mean red, green and blue value for each area.
3. **Even out the timing.** Webcam frames arrive at uneven intervals, so samples are interpolated onto an even 30 Hz grid.
4. **Extract the pulse with POS.** The Plane-Orthogonal-to-Skin algorithm (Wang et al., 2017) combines the three channels to cancel lighting and motion changes and keep the blood-flow color change. Each skin area gets its own pulse signal.
5. **Filter.** Only 0.7-3.5 Hz is kept (42-210 BPM).
6. **Find the rate.** An FFT of each area's pulse signal is normalized and the spectra are added together, so the heartbeat (present in every area) adds up while noise (different in each area) does not. The strongest frequency x 60 is the BPM. The estimate is then refined by timing the individual beats. Readings from a noisy signal are dropped, and the median of the last 3 good readings is shown.

### Breathing

Breathing moves the chest and shoulders far more than the head. When the shoulders are in view, the app tracks their up-and-down motion with optical flow. It also tracks the head's vertical movement and uses whichever of the two shows the clearer breathing rhythm. Filtering to 0.1-0.5 Hz gives 6-30 breaths per minute.

### Blinks

The eye aspect ratio (eye height / eye width) drops during a blink. The threshold adapts to each person's open-eye level.

### Experimental

The code also includes a motion-based pulse tracker (head and neck movement, ballistocardiography). For now it only follows skin points and is not used for the heart rate shown.

## Setup

Use Python 3.10-3.12. MediaPipe can lag behind the newest Python versions. If `pip install` fails on 3.12, use 3.10 or 3.11.

```bash
git clone https://github.com/LeoSLayer1-Arif/cuore.git
cd cuore
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python test_vitals.py           # optional: checks the math with fake signals
python app.py
```

The face model (`face_landmarker.task`) is included in the repo. If it is missing, the app downloads it (a few MB) on first run. On macOS, allow camera access for your terminal.

Sit still facing a window or lamp while the app starts up. Keys: `q` or Esc quits, `r` restarts the average heart rate recording.

Options for the heart-rate mode:

```bash
python app.py                              # default: heart rate from open-rppg
python app.py --hr colour                  # heart rate from this project's own skin-color pipeline
python app.py --rppg-model ME-flow.rlap    # try a different open-rppg model
```

The dashboard shows the live heart rate next to an **average heart rate** card. The first 10 seconds of readings are a calibration period and are left out of the average. After that, the average records one reading per second for 1 minute, pausing while no face or reading is available, then shows the final value until you press `r` (which also restarts calibration). Change the length with `--avg-seconds`, e.g. `python app.py --avg-seconds 90`. The pulse graph is in the top-right corner and the breathing graph along the bottom.

To use an external webcam, pass its index: `python app.py --camera 1` (run `python find_cameras.py` to list cameras).

### Reading someone on a video call

Find the pixel position of their video tile and run:

```bash
python app.py --screen 100 100 640 480    # left top width height
```

Keep the app window off that region, or it will capture its own overlay. Video calls compress the image and weaken the signal, so ask the other person to sit in good light.

## Checking accuracy

Buy a fingertip pulse oximeter (about $15) and wear it while the app runs. After about 10 seconds the two numbers should be within roughly 3 BPM. In our own tests the difference was never more than 2 BPM.

## Troubleshooting

| Problem | Fix |
|---|---|
| Reading unstable or wrong | Face steady daylight or a lamp. Avoid flickering overhead lights and backlighting. |
| FPS below 15 | Close other apps. |
| Reads double or half your pulse (`--hr colour`) | Narrow `HR_BAND_HZ` in `vitals.py`, for example to `(0.8, 2.5)` for people at rest. |
| "Hold still" never goes away (`--hr colour`) | Lower `min_snr_db` from -3.0 to -6.0 in `HeartRateEstimator`. |
| Error about `mediapipe.tasks` | Old MediaPipe. Run `pip install -U mediapipe`. |
| `import cv2` misbehaves | MediaPipe installs `opencv-contrib-python`, which can clash with `opencv-python`. Uninstall both, then install one. |
| Green outlines sit on hair or background | Adjust the landmark lists `FOREHEAD`, `LEFT_CHEEK`, `RIGHT_CHEEK` in `app.py`. |
| Breathing rate is erratic | Expected for the first 30 seconds. It is the weakest signal. Sitting back so your shoulders are in view gives a much cleaner reading. |

## Limitations and ethics

- Not a medical device. Do not use it for diagnosis.
- Accuracy drops with motion, dim or flickering light, video compression, and darker skin tones, where the color signal is weaker.
- The default heart-rate mode uses pretrained models from open-rppg. Their licenses come from the original research papers, so check them before using this project commercially.
- Get consent before measuring anyone, especially over a video call.

## Stretch goals

- **Heart rate variability:** find beats in `heart.waveform` with `scipy.signal.find_peaks`, then compute RMSSD of the beat-to-beat intervals. HRV carries more information than raw heart rate.
- **CSV logging:** save the app's readings next to the oximeter's and chart the difference.

## References

- Wang, Stuijk, de Haan. "Algorithmic Principles of Remote PPG." IEEE Trans. Biomedical Engineering, 2017 (the POS algorithm).
- Soukupova, Cech. "Real-Time Eye Blink Detection using Facial Landmarks." 2016 (eye aspect ratio).
- Balakrishnan, Durand, Guttag. "Detecting Pulse from Head Motions in Video." CVPR 2013 (the experimental motion tracker).
- [open-rppg](https://github.com/KegangWangCCNU/open-rppg), a Python toolbox for rPPG inference, used for the default heart-rate mode. Its code is MIT licensed. Its pretrained models follow their authors' licenses, and its README lists the papers behind each model.
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)

## License

The code in this repository is released under the MIT License (see `LICENSE`). The pretrained models used by open-rppg are covered by their own licenses.

# Cuore web app

A phone-friendly web version of the cuore desktop app. It measures heart rate, breathing rate and blinks from the camera, and shows the same dashboard: live BPM, a 2-minute average BPM, a pulse graph and a breathing graph.

Everything runs in the browser. Video never leaves the device.

## Running it

The camera only works on an `https://` page or on `localhost`, so the app has to be served by a web server. Opening `index.html` directly from disk doesn't work.

**On a computer:**
```bash
cd cuore-web
python -m http.server 8000
```
Then open http://localhost:8000.

**On a phone:** host the folder on any static HTTPS host, for example GitHub Pages, Netlify or Cloudflare Pages, and open the link. In Safari (iPhone) or Chrome (Android), use **Share → Add to Home Screen** to install it like an app.

## Using it

- Tap **Start measuring** and allow the camera.
- Face a window or lamp, rest the phone on something, and hold still. The first heart rate appears after about 6 seconds, and breathing after about 15 seconds.
- The **Average** card records one reading per second. It pauses whenever there's no reading, and shows **FINAL** once it has 1:30 or 2:00 of readings. Tap ↻ (or press `r` on a keyboard) to start again.
- The camera button switches between cameras (front/back, or an external webcam on a laptop).
- Adding `?avg=60` to the address sets a custom average length in seconds.

## How it differs from the desktop app

| | Desktop (`app.py`) | Web |
|---|---|---|
| Heart rate | open-rppg deep-learning models by default, colour (POS) optional | colour (POS) only |
| Breathing | chest optical flow (OpenCV Farneback) + head movement | chest movement (vertical Lucas-Kanade on strong edges) + head movement |
| Motion pulse tracking (head/neck points) | shown, experimental | not included |

The signal processing in `js/dsp.js` and `js/vitals.js` is a direct port of `vitals.py`. The filters, spectra, peak picking and beat timing match the SciPy versions to about 1e-14.

## Files

- `index.html`, `styles.css`: page and layout. A phone in portrait gets the camera on top with cards below. Wide screens get the camera full-screen, the pulse graph top-right and breathing along the bottom.
- `js/main.js`: camera, face tracking (MediaPipe Face Landmarker), main loop, dashboard.
- `js/vitals.js`: heart rate, breathing, blink and average-BPM estimators.
- `js/dsp.js`: filtering, FFT, peak finding (ported from NumPy/SciPy).
- `js/face.js`: face regions, skin colour sampling, eye aspect ratio, chest motion.
- `js/graph.js`: graph drawing.
- `models/face_landmarker.task`: MediaPipe face model (served with the app).

MediaPipe's JavaScript and WebAssembly are loaded from jsDelivr, pinned to `@mediapipe/tasks-vision@1.2.3`.

Not a medical device. Readings are estimates.

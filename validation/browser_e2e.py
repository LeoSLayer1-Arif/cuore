"""End-to-end test: a real Chromium, playing the synthetic face video as its camera,
talks to the real server.py over HTTPS and shows the results.

    python validation/browser_e2e.py --chrome /path/to/chrome --seconds 90

What it checks:
  - the page opens the camera (front camera constraints), sends frames, and the
    laptop processes them with the Python pipeline (heart rate appears);
  - the dashboard shows live BPM, waveforms and the average monitor;
  - frame rate, skipped frames, round trip and end-to-end delay;
  - Stop releases the camera and the server ends the session;
  - camera permission denied shows a clear message;
  - stopping the server mid-measurement shows "connection lost" and clears the BPM.
Screenshots go to --shots.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--chrome", required=True, help="Chromium/Chrome executable")
    p.add_argument("--seconds", type=float, default=90.0, help="length of the measurement")
    p.add_argument("--hr", choices=["rppg", "colour"], default="colour")
    p.add_argument("--avg-seconds", type=float, default=60)
    p.add_argument("--work", default=os.path.join(ROOT, ".e2e"), help="scratch folder")
    p.add_argument("--shots", default=os.path.join(ROOT, ".e2e", "shots"))
    p.add_argument("--port", type=int, default=8443)
    return p.parse_args()


def make_fake_camera(path, seconds):
    """Chrome can use an MJPEG file as its camera (it plays it at 30 fps and loops)."""
    sys.path.insert(0, HERE)
    import cv2
    from frames import synthetic_frames
    with open(path, "wb") as f:
        for _, frame in synthetic_frames(seconds + 5):
            f.write(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 97])[1].tobytes())


def make_certificate(folder, ip):
    """A throwaway self-signed certificate (test only; real use: mkcert, see README)."""
    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "cuore-test")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address(ip)),
                 x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    return cert_path, key_path


def snapshot(page):
    return page.evaluate("""() => {
        const v = state.vitals, st = state.stats;
        return {
          measuring: state.measuring, ready: state.ready,
          live: document.getElementById('live-value').textContent,
          status: document.getElementById('status-text').textContent,
          avg_tag: document.getElementById('avg-tag-text').textContent,
          avg_value: document.getElementById('avg-value').textContent,
          avg_footer: document.getElementById('avg-footer').textContent,
          banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,
          rows: [...document.querySelectorAll('#rows .row')].map(r => r.textContent),
          notes: [...document.querySelectorAll('#notes div')].map(r => r.textContent),
          server_bpm: v ? v.bpm : null, server_state: v ? v.state : null,
          pulse_samples: v ? v.pulse.samples.length : 0, breath_samples: v ? v.breath.samples.length : 0,
          perf: v ? v.perf : null,
          phone: { camera_fps: rate(st.presented), sent_fps: rate(st.sent),
                   skipped_in_flight: st.skippedInFlight, skipped_busy: st.skippedBusy,
                   skipped_time: st.skippedTime, dropped_by_server: st.droppedByServer,
                   missed_callbacks: st.missedCallbacks, rtt_ms: mean(st.rtt), latency_ms: mean(st.latency),
                   timestamps: state.timestampSource, frame: [state.canvas.width, state.canvas.height] },
          tracks: state.stream ? state.stream.getTracks().map(t => t.readyState) : [],
        };
    }""")


def main():
    args = parse_args()
    os.makedirs(args.work, exist_ok=True)
    os.makedirs(args.shots, exist_ok=True)
    sys.path.insert(0, ROOT)
    import server as cuore_server
    ip = cuore_server.lan_address()
    print("LAN address:", ip)
    camera = os.path.join(args.work, "face.mjpeg")
    if not os.path.exists(camera):
        print("Writing fake camera video...")
        make_fake_camera(camera, args.seconds)
    cert, key = make_certificate(args.work, ip)

    log_path = os.path.join(args.work, "server.log")
    log = open(log_path, "w")
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--host", ip,
                            "--port", str(args.port), "--cert", cert, "--key", key,
                            "--hr", args.hr, "--avg-seconds", str(args.avg_seconds)],
                           stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
    url = f"https://{ip}:{args.port}/"
    results = {"url": url, "samples": []}
    from playwright.sync_api import sync_playwright

    try:
        import urllib.request, ssl
        ctx = ssl.create_default_context(cafile=cert)
        for _ in range(240):                                  # wait for the server (model load)
            try:
                urllib.request.urlopen(url, context=ctx, timeout=2).read()
                break
            except Exception:
                time.sleep(0.5)
        flags = ["--no-sandbox", "--use-fake-ui-for-media-stream",
                 "--use-fake-device-for-media-stream", f"--use-file-for-fake-video-capture={camera}",
                 "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required"]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chrome, args=flags)
            phone = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                        is_mobile=True, has_touch=True, permissions=["camera"],
                                        ignore_https_errors=True)
            page = phone.new_page()
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.goto(url)
            results["secure_context"] = page.evaluate("window.isSecureContext")
            page.click("#start")
            started = time.time()
            shot_times = {20: "phone_portrait_20s.png", args.seconds - 5: "phone_portrait_end.png"}
            while time.time() - started < args.seconds:
                time.sleep(5)
                s = snapshot(page)
                s["t"] = round(time.time() - started, 1)
                results["samples"].append(s)
                print(json.dumps({k: s[k] for k in ("t", "live", "status", "avg_tag", "avg_value",
                                                    "avg_footer")}), flush=True)
                for at, name in list(shot_times.items()):
                    if s["t"] >= at:
                        page.screenshot(path=os.path.join(args.shots, name), full_page=True)
                        del shot_times[at]
            page.set_viewport_size({"width": 1280, "height": 960})
            time.sleep(1.5)
            page.screenshot(path=os.path.join(args.shots, "large_screen_board.png"))
            results["final_running"] = snapshot(page)
            page.click("#stop")
            time.sleep(4)
            results["after_stop"] = snapshot(page)
            page.screenshot(path=os.path.join(args.shots, "after_stop.png"))
            results["console"] = console[-30:]

            # Camera permission denied.
            denied = browser.new_context(viewport={"width": 390, "height": 844}, ignore_https_errors=True)
            denied.clear_permissions()
            page2 = denied.new_page()
            page2.goto(url)
            page2.evaluate("""() => { navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); }""")
            page2.click("#start")
            time.sleep(1.5)
            results["permission_denied"] = snapshot(page2)
            denied.close()

            # Server goes away mid-measurement.
            page.set_viewport_size({"width": 390, "height": 844})
            page.click("#start")
            for _ in range(60):
                time.sleep(1)
                if snapshot(page)["live"] != "--":
                    break
            results["before_server_loss"] = snapshot(page)
            srv.send_signal(signal.SIGINT)
            srv.wait(timeout=30)
            time.sleep(2)
            results["after_server_loss"] = snapshot(page)
            page.screenshot(path=os.path.join(args.shots, "server_lost.png"), full_page=True)
            browser.close()
    finally:
        if srv.poll() is None:
            srv.send_signal(signal.SIGINT)
            try:
                srv.wait(timeout=30)
            except subprocess.TimeoutExpired:
                srv.kill()
        log.close()
    out = os.path.join(args.work, "browser_e2e.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=1, default=str)
    print("results ->", out)


if __name__ == "__main__":
    main()

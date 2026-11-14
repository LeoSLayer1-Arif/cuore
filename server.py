"""Cuore phone server: the phone is the camera and the screen, this laptop does all the measuring.

The phone opens the Cuore page, films your face with its front camera and
sends the frames here over a WebSocket. Every frame goes through the same
VitalsPipeline as the desktop app (app.py), so heart rate, breathing and the
average are computed by exactly the same Python code. The results go back to
the phone, which only draws them.

Usage (see README for the HTTPS certificate setup):
    python server.py                               # open-rppg heart rate, HTTPS on the LAN address
    python server.py --hr colour                   # this app's own colour-based heart rate
    python server.py --avg-seconds 120             # length of the average heart rate recording
    python server.py --http --host 127.0.0.1       # plain HTTP, only on this laptop (testing)
"""
import argparse
import asyncio
import ipaddress
import json
import logging
import math
import os
import queue
import socket
import struct
import threading
import time
from collections import deque
from urllib.parse import urlparse

import cv2
import numpy as np

import app as cuore

log = logging.getLogger("cuore.server")

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DEFAULT_CERT = os.path.join(HERE, "certs", "cuore.pem")
DEFAULT_KEY = os.path.join(HERE, "certs", "cuore-key.pem")

# Binary frame message: header followed by a JPEG (or PNG) image.
FRAME_MAGIC = b"CUO1"
FRAME_HEADER = struct.Struct("<4sId")   # magic, sequence number, capture time (ms since 1970)
MAX_FRAME_BYTES = 2_000_000
MAX_FRAME_SIDE = 1920

MAX_IN_FLIGHT = 2      # the phone waits for an ack once this many frames are unanswered
MAX_QUEUE = 2          # frames waiting here; a longer queue would only add delay
GAP_WARN_SEC = 0.5     # longer gaps between frames are reported to the phone
GAP_RECENT_SEC = 3.0   # ... for this long
VITALS_EVERY_SEC = 0.2
LOG_EVERY_SEC = 10.0

# What the phone should capture. The desktop app works on 640x480 webcam frames,
# and bigger frames would be shrunk to 640 wide anyway (prepare_camera_frame).
CAPTURE = {"max_side": 640, "frame_rate": 30, "jpeg_quality": 0.92}


def bgr_hex(color):
    b, g, r = color
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def clean(value):
    """Make a value JSON-safe: NumPy numbers to Python, NaN/inf to None."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return value if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


def wave_samples(wave, fs, seconds):
    """The last `seconds` of a waveform, rounded (the graph only needs its shape)."""
    if wave is None or fs is None or len(wave) < 2:
        return []
    segment = np.asarray(wave[-int(seconds * fs):], dtype=float)
    return [float(f"{x:.5g}") for x in segment]


class FrameError(ValueError):
    pass


def parse_frame(data):
    """Split a binary frame message into (sequence number, capture time in seconds, image bytes)."""
    if len(data) <= FRAME_HEADER.size:
        raise FrameError("frame message too short")
    if len(data) > MAX_FRAME_BYTES:
        raise FrameError("frame too large")
    magic, seq, capture_ms = FRAME_HEADER.unpack_from(data)
    if magic != FRAME_MAGIC:
        raise FrameError("not a Cuore frame")
    if not math.isfinite(capture_ms) or capture_ms <= 0:
        raise FrameError("bad capture time")
    return seq, capture_ms / 1000.0, data[FRAME_HEADER.size:]


def decode_image(payload):
    image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise FrameError("could not decode image")
    h, w = image.shape[:2]
    if h < 32 or w < 32 or max(h, w) > MAX_FRAME_SIDE:
        raise FrameError(f"unsupported frame size {w}x{h}")
    return image


class FrameProcessor:
    """Runs phone frames through the desktop app's VitalsPipeline and builds the replies.

    Not thread-safe: one worker thread owns it. It never touches the network,
    so the validation scripts can drive it directly.
    """

    def __init__(self, pipeline):
        self.pipeline = pipeline
        self.last_seq = None
        self.last_capture = None
        self.last_vitals = -1e9
        self.last_log = time.monotonic()
        self.received = deque(maxlen=60)       # arrival times (laptop clock)
        self.proc_ms = deque(maxlen=60)
        self.client = {}                        # latest stats reported by the phone
        self.frame_size = None
        self.counts = {"processed": 0, "dropped_busy": 0, "dropped_order": 0,
                       "dropped_bad": 0, "gaps": 0}
        self.last_gap = None                    # (gap seconds, laptop time it was seen)
        self.max_gap = 0.0

    # ----- frames -----

    def process(self, seq, capture_s, payload, received_at):
        """Process one frame. Returns the messages to send back to the phone."""
        started = time.monotonic()
        if self.last_seq is not None and seq <= self.last_seq:
            self.counts["dropped_order"] += 1
            return [self.ack(seq, dropped="out_of_order")]
        if self.last_capture is not None and capture_s <= self.last_capture:
            # The measurement code needs strictly increasing times (it interpolates).
            self.counts["dropped_order"] += 1
            return [self.ack(seq, dropped="timestamp_not_increasing")]
        try:
            raw = decode_image(payload)
        except FrameError as error:
            self.counts["dropped_bad"] += 1
            return [self.ack(seq, dropped=str(error))]

        if self.last_capture is not None:
            gap = capture_s - self.last_capture
            if gap > GAP_WARN_SEC:
                self.counts["gaps"] += 1
                self.last_gap = (gap, started)
                self.max_gap = max(self.max_gap, gap)
                log.info("Gap of %.2f s between frames %s and %s", gap, self.last_seq, seq)
        self.last_seq, self.last_capture = seq, capture_s
        self.received.append(received_at)

        # Same mirroring and resizing as the webcam path, then the shared pipeline.
        frame, full_frame = cuore.prepare_camera_frame(raw)
        self.frame_size = (frame.shape[1], frame.shape[0])
        result = self.pipeline.process(frame, full_frame, capture_s)
        self.counts["processed"] += 1
        done = time.monotonic()
        proc_ms = (done - started) * 1000.0
        self.proc_ms.append(proc_ms)

        messages = [self.ack(seq, proc_ms=proc_ms, queue_ms=(started - received_at) * 1000.0)]
        if done - self.last_vitals >= VITALS_EVERY_SEC:
            self.last_vitals = done
            messages.append(self.vitals(result, done))
        if done - self.last_log >= LOG_EVERY_SEC:
            self.last_log = done
            log.info("Session: %s", json.dumps(clean(self.perf())))
        return messages

    def ack(self, seq, dropped=None, proc_ms=None, queue_ms=None):
        msg = {"type": "ack", "seq": seq}
        if dropped:
            msg["dropped"] = dropped
        else:
            msg["proc_ms"] = round(proc_ms, 1)
            msg["queue_ms"] = round(queue_ms, 1)
        return msg

    def drop_busy(self, seq):
        """Called from the network side when the queue is full."""
        self.counts["dropped_busy"] += 1
        return self.ack(seq, dropped="server_busy")

    # ----- replies -----

    def perf(self):
        return {
            "received_fps": round(cuore.rate_from_times(self.received), 1),
            "processed_fps": round(self.pipeline.processed_fps, 1),
            "proc_ms": round(float(np.mean(self.proc_ms)), 1) if self.proc_ms else None,
            "max_gap_s": round(self.max_gap, 2),
            **self.counts,
            "phone": self.client,
        }

    def vitals(self, result, now):
        p = self.pipeline
        avg = p.average
        tag, tag_color, value, value_color, footer = cuore.average_card_text(avg)
        camera_fps = self.client.get("camera_fps") or cuore.rate_from_times(self.received)
        rows, notes = p.text_rows(result, camera_fps)

        if p.rppg_hr is not None:
            quality = {"kind": "sqi", "value": p.rppg_hr.sqi,
                       "good_at_least": cuore.RppgHeartRate.GOOD_SQI}
        else:
            quality = {"kind": "snr_db", "value": p.heart.snr_db,
                       "good_at_least": p.heart.min_snr_db}

        overlay = {"frame": self.frame_size, "mode": "colour" if p.rppg_hr is None else "rppg"}
        if result.face_found:
            overlay["polygons"] = [poly.tolist() for poly in result.polygons]
            if result.rppg_box is not None:
                (top, bottom), (left, right) = result.rppg_box
                overlay["box"] = [left, top, right, bottom]
            overlay["chest"] = list(result.chest_box) if result.chest_box is not None else None
            overlay["motion"] = [[o.tolist() for o in outlines]
                                 for outlines in result.motion_outlines]
            overlay["motion_points"] = [np.round(pts, 1).tolist() for pts in result.motion_points]

        gap = None
        if self.last_gap is not None and now - self.last_gap[1] < GAP_RECENT_SEC:
            gap = round(self.last_gap[0], 2)

        return clean({
            "type": "vitals",
            "t": result.now,
            "face": result.face_found,
            "state": result.state,
            "status": result.status[0],
            "status_color": bgr_hex(result.status[1]),
            "bpm": result.live_bpm,
            "bpm_text": f"{result.live_bpm:.0f}" if result.live_bpm is not None else "--",
            "hr_source": p.hr_source,
            "quality": quality,
            "average": {
                "title": f"AVERAGE ({cuore.format_duration(avg.duration)})",
                "tag": tag, "tag_color": bgr_hex(tag_color),
                "value": value, "value_color": bgr_hex(value_color),
                "footer": footer, "progress": avg.progress,
                "done": avg.done, "result": avg.result, "readings": len(avg.readings),
            },
            "rows": rows,
            "notes": notes,
            "pulse": {"fs": result.pulse_fs, "seconds": 5,
                      "samples": wave_samples(result.pulse_wave, result.pulse_fs, 5)},
            "breath": {"fs": cuore.RESP_FS, "seconds": 30,
                       "samples": wave_samples(result.breath_wave, cuore.RESP_FS, 30)},
            "overlay": overlay,
            "gap_s": gap,
            "perf": self.perf(),
        })

    def summary(self):
        avg = self.pipeline.average
        return clean({"type": "stopped", "average": avg.result, "readings": len(avg.readings),
                      "perf": self.perf()})


class PipelineFactory:
    """Builds VitalsPipelines. Keeps one ready in advance, because loading the
    open-rppg model takes several seconds."""

    def __init__(self, hr, rppg_model, avg_seconds):
        self.args = (hr, rppg_model, avg_seconds)
        self.lock = threading.Lock()
        self.spare = None
        self.loading = None
        self.closed = False
        self.prepare()

    def close(self):
        """Stop preparing pipelines and release the spare one."""
        with self.lock:
            self.closed = True
            loading = self.loading
        if loading is not None:
            loading.join()
        with self.lock:
            spare, self.spare = self.spare, None
        if spare is not None:
            spare.close()

    def _build(self):
        started = time.monotonic()
        pipeline = cuore.VitalsPipeline(*self.args)
        log.info("Measurement pipeline ready (%s) in %.1f s", pipeline.hr_source,
                 time.monotonic() - started)
        return pipeline

    def prepare(self):
        def load():
            try:
                pipeline = self._build()
            except Exception:
                log.exception("Could not prepare a measurement pipeline")
                pipeline = None
            with self.lock:
                self.spare = pipeline
                self.loading = None
        with self.lock:
            if self.spare is None and self.loading is None and not self.closed:
                self.loading = threading.Thread(target=load, daemon=True)
                self.loading.start()

    def get(self):
        """A fresh pipeline (blocks while one is being loaded)."""
        with self.lock:
            loading = self.loading
        if loading is not None:
            loading.join()
        with self.lock:
            pipeline, self.spare = self.spare, None
        if pipeline is None:
            pipeline = self._build()
        self.prepare()                           # start loading the next one
        return pipeline


class Session:
    """One phone measuring. Frames are processed in order on a worker thread."""

    def __init__(self, factory, emit):
        self.factory = factory
        self.emit = emit                         # thread-safe: hands a message to the sender
        self.frames = queue.Queue(maxsize=MAX_QUEUE)
        self.commands = queue.Queue()
        self.stopping = threading.Event()
        self.processor = None
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def offer_frame(self, data, received_at):
        try:
            seq, capture_s, payload = parse_frame(data)
        except FrameError as error:
            self.emit({"type": "error", "code": "bad_frame", "message": str(error)})
            return
        if not self.ready.is_set():
            self.emit({"type": "ack", "seq": seq, "dropped": "not_ready"})
            return
        try:
            self.frames.put_nowait((seq, capture_s, payload, received_at))
        except queue.Full:
            self.emit(self.processor.drop_busy(seq))

    def command(self, msg):
        self.commands.put(msg)

    def stop(self):
        self.stopping.set()

    def _run(self):
        pipeline = None
        try:
            self.emit({"type": "loading"})
            pipeline = self.factory.get()
            self.processor = FrameProcessor(pipeline)
            self.ready.set()
            self.emit({"type": "ready", "hr_source": pipeline.hr_source,
                       "avg_seconds": pipeline.average.duration,
                       "calibration_seconds": pipeline.average.calibration,
                       "max_in_flight": MAX_IN_FLIGHT, "capture": CAPTURE})
            log.info("Measurement started (%s)", pipeline.hr_source)
            while not self.stopping.is_set():
                self._handle_commands()
                try:
                    seq, capture_s, payload, received_at = self.frames.get(timeout=0.2)
                except queue.Empty:
                    continue
                for msg in self.processor.process(seq, capture_s, payload, received_at):
                    self.emit(msg)
        except Exception as error:
            log.exception("Processing failed")
            self.emit({"type": "error", "code": "processing", "message": str(error)})
        finally:
            if self.processor is not None:
                self.emit(self.processor.summary())
                log.info("Measurement stopped: %s", json.dumps(clean(self.processor.perf())))
            if pipeline is not None:
                try:
                    pipeline.close()
                except Exception:
                    log.exception("Closing the pipeline failed")

    def _handle_commands(self):
        while True:
            try:
                msg = self.commands.get_nowait()
            except queue.Empty:
                return
            kind = msg.get("type")
            if kind == "reset_average":
                self.processor.pipeline.average.reset()
                log.info("Average heart rate recording restarted")
            elif kind == "stats":
                allowed = ("camera_fps", "sent_fps", "skipped_busy", "skipped_in_flight",
                           "rtt_ms", "latency_ms", "width", "height")
                self.processor.client = {k: msg[k] for k in allowed
                                         if isinstance(msg.get(k), (int, float))}


def create_app(factory):
    from fastapi import FastAPI, WebSocket
    from fastapi.staticfiles import StaticFiles
    from starlette.websockets import WebSocketDisconnect, WebSocketState

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)   # no debug endpoints
    active = {"session": None}
    active_lock = asyncio.Lock()

    @web.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
        return response

    def same_origin(ws):
        """Browsers send Origin with WebSockets. Refuse pages from other sites."""
        origin = ws.headers.get("origin")
        if origin is None:
            return True                          # not a browser (e.g. the validation client)
        return urlparse(origin).netloc == ws.headers.get("host")

    @web.websocket("/ws")
    async def websocket(ws: WebSocket):
        if not same_origin(ws):
            log.warning("Refused WebSocket from origin %s", ws.headers.get("origin"))
            await ws.close(code=1008)
            return
        await ws.accept()
        peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
        log.info("Phone connected from %s", peer)
        loop = asyncio.get_running_loop()
        outbox = asyncio.Queue()
        session = None

        def emit(msg):
            try:
                loop.call_soon_threadsafe(outbox.put_nowait, msg)
            except RuntimeError:
                pass                             # the connection is already gone

        async def sender():
            while True:
                msg = await outbox.get()
                await ws.send_text(json.dumps(clean(msg), allow_nan=False))

        send_task = asyncio.create_task(sender())

        async def end_session():
            nonlocal session
            if session is None:
                return
            session.stop()
            await asyncio.to_thread(session.thread.join)
            async with active_lock:
                if active["session"] is session:
                    active["session"] = None
            session = None

        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    if session is None:
                        emit({"type": "error", "code": "not_started",
                              "message": "Press Start before sending frames"})
                    else:
                        session.offer_frame(message["bytes"], time.monotonic())
                    continue
                try:
                    msg = json.loads(message.get("text") or "")
                    kind = msg.get("type")
                except (ValueError, AttributeError):
                    emit({"type": "error", "code": "bad_message", "message": "Expected JSON"})
                    continue
                if kind == "start":
                    if session is not None:
                        continue
                    async with active_lock:
                        busy = active["session"] is not None
                        if not busy:
                            session = Session(factory, emit)
                            active["session"] = session
                    if busy:
                        emit({"type": "error", "code": "busy",
                              "message": "Another phone is measuring. Stop it first."})
                elif kind == "stop":
                    await end_session()
                elif kind in ("reset_average", "stats") and session is not None:
                    session.command(msg)
                elif kind == "ping":
                    emit({"type": "pong", "t": msg.get("t")})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("WebSocket error")
        finally:
            await end_session()
            # Let the last messages (e.g. the stop summary) go out, then shut down.
            if ws.client_state == WebSocketState.CONNECTED:
                for _ in range(20):
                    if outbox.empty():
                        break
                    await asyncio.sleep(0.05)
            send_task.cancel()
            log.info("Phone disconnected (%s)", peer)

    web.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return web


def lan_address():
    """This laptop's address on the local network (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def parse_args():
    p = argparse.ArgumentParser(description="Cuore server: phone camera, laptop measurement")
    p.add_argument("--host", default="auto",
                   help="address to listen on (default: this laptop's local network address)")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--cert", default=DEFAULT_CERT, help="HTTPS certificate (PEM)")
    p.add_argument("--key", default=DEFAULT_KEY, help="HTTPS private key (PEM)")
    p.add_argument("--http", action="store_true",
                   help="plain HTTP; only allowed on 127.0.0.1 (phones need HTTPS for the camera)")
    p.add_argument("--hr", choices=["rppg", "colour"], default="rppg",
                   help="heart rate source: rppg (open-rppg library) or colour (this app's own)")
    p.add_argument("--rppg-model", default="FacePhys.rlap",
                   help="open-rppg model name, e.g. FacePhys.rlap, ME-flow.rlap, PhysFormer.pure")
    p.add_argument("--avg-seconds", type=float, default=120,
                   help="how many seconds of heart rate readings the average uses (default 120)")
    p.add_argument("--log-level", default="INFO")
    args = p.parse_args()
    if args.avg_seconds < 10:
        p.error("--avg-seconds must be at least 10")
    return args


def main():
    args = parse_args()
    logging.basicConfig(level=args.log_level.upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    host = args.host
    if host == "auto":
        host = "127.0.0.1" if args.http else lan_address()
        if host is None:
            raise SystemExit("Could not find this laptop's network address. "
                             "Connect to Wi-Fi or pass --host.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise SystemExit(f"--host must be an IP address, got {host!r}")
    if args.http and not address.is_loopback:
        raise SystemExit("--http is only allowed with --host 127.0.0.1. Phones need HTTPS "
                         "for the camera, and video should not cross the network unencrypted.")
    if not (address.is_private or address.is_loopback or address.is_unspecified):
        raise SystemExit(f"{host} is a public address. Cuore only listens on a local network.")
    ssl = {}
    if not args.http:
        if not (os.path.exists(args.cert) and os.path.exists(args.key)):
            raise SystemExit(
                f"HTTPS certificate not found ({args.cert}).\nCreate one with mkcert:\n"
                f"  mkcert -install\n"
                f"  mkcert -cert-file certs/cuore.pem -key-file certs/cuore-key.pem "
                f"{host if not address.is_unspecified else 'YOUR_LAN_IP'} localhost 127.0.0.1\n"
                f"See README.md, 'Phone camera mode'.")
        ssl = {"ssl_certfile": args.cert, "ssl_keyfile": args.key}

    factory = PipelineFactory(args.hr, args.rppg_model, args.avg_seconds)
    scheme = "http" if args.http else "https"
    shown = lan_address() if address.is_unspecified else host
    print(f"\nCuore is starting. On your phone (same Wi-Fi), open:\n\n    {scheme}://{shown}:{args.port}\n")
    import uvicorn
    uvicorn.run(create_app(factory), host=host, port=args.port, log_level="warning",
                ws_max_size=MAX_FRAME_BYTES + 1024, **ssl)


if __name__ == "__main__":
    main()

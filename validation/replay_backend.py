"""Send recorded or synthetic frames through the phone backend and record what it computes.

The frames take the same path as phone frames: encoded as images, wrapped in
the binary frame header, (optionally) sent over a real WebSocket to the real
server, decoded, mirrored, and processed by FrameProcessor/VitalsPipeline.

    python validation/replay_backend.py --hr colour --out results/backend_colour.pkl
    python validation/replay_backend.py --transport direct --encoding jpeg --out jpeg.pkl

--encoding png (default) is lossless, so the backend sees exactly the pixels
the desktop app saw; that is the numerical-equivalence test. --encoding jpeg
uses the phone's JPEG quality, to measure how much compression changes results.
"""
import argparse
import json
import os
import socket
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CAPTURE_BASE_MS = 1000.0 * 1000.0       # capture times start at "1000 s", like the desktop replay


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--hr", choices=["rppg", "colour"], default="colour")
    p.add_argument("--rppg-model", default="FacePhys.rlap")
    p.add_argument("--avg-seconds", type=float, default=60)
    p.add_argument("--video", help="recorded video file (default: synthetic face video)")
    p.add_argument("--seconds", type=float, default=100.0)
    p.add_argument("--transport", choices=["websocket", "direct"], default="websocket")
    p.add_argument("--encoding", choices=["png", "jpeg"], default="png")
    p.add_argument("--out", required=True)
    return p.parse_args()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    args = parse_args()
    sys.path.insert(0, HERE)
    sys.path.insert(0, ROOT)
    import cv2
    import app as cuore
    import vitals
    import server
    from frames import frames_from_args
    from record import Recorder

    recorder = Recorder(cuore, vitals)
    recorder.install()

    # Snapshot every frame the pipeline processes, in the same form as the desktop replay.
    original_process = cuore.VitalsPipeline.process

    def process(pipeline, frame, full_frame, arrived):
        recorder.begin_frame()
        result = original_process(pipeline, frame, full_frame, arrived)
        rows, _ = pipeline.text_rows(result, 0.0)
        recorder.snapshot(result.now, result.live_bpm, pipeline.hr_source, pipeline.average,
                          rows, result.status, result.pulse_wave, result.pulse_fs,
                          result.breath_wave)
        return result

    cuore.VitalsPipeline.process = process

    quality = int(round(server.CAPTURE["jpeg_quality"] * 100))

    def encode(frame):
        if args.encoding == "png":
            ok, data = cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        else:
            ok, data = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        assert ok
        return data.tobytes()

    def message(seq, t, frame):
        capture_ms = CAPTURE_BASE_MS + t * 1000.0
        return server.FRAME_HEADER.pack(server.FRAME_MAGIC, seq, capture_ms) + encode(frame)

    frames = frames_from_args(args)
    vitals_messages, acks = [], []
    start = time.perf_counter()

    if args.transport == "direct":
        pipeline = cuore.VitalsPipeline(args.hr, args.rppg_model, args.avg_seconds)
        processor = server.FrameProcessor(pipeline)
        for seq, (t, frame) in enumerate(frames):
            s, capture_s, payload = server.parse_frame(message(seq, t, frame))
            for msg in processor.process(s, capture_s, payload, time.monotonic()):
                (acks if msg["type"] == "ack" else vitals_messages).append(server.clean(msg))
        pipeline.close()
        perf = processor.perf()
    else:
        import uvicorn
        from websockets.sync.client import connect

        port = free_port()
        factory = server.PipelineFactory(args.hr, args.rppg_model, args.avg_seconds)
        config = uvicorn.Config(server.create_app(factory), host="127.0.0.1", port=port,
                                log_level="warning", ws_max_size=server.MAX_FRAME_BYTES + 1024)
        uv = uvicorn.Server(config)
        thread = threading.Thread(target=uv.run, daemon=True)
        thread.start()
        while not uv.started:
            time.sleep(0.05)
        perf = None
        with connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as ws:
            ws.send(json.dumps({"type": "start"}))
            while json.loads(ws.recv())["type"] != "ready":
                pass
            for seq, (t, frame) in enumerate(frames):
                ws.send(message(seq, t, frame))
                # One frame in flight: wait for its ack so that no frame is skipped and the
                # backend sees exactly the same sequence as the desktop replay.
                while True:
                    msg = json.loads(ws.recv())
                    if msg["type"] == "ack" and msg["seq"] == seq:
                        acks.append(msg)
                        break
                    if msg["type"] == "vitals":
                        vitals_messages.append(msg)
                    elif msg["type"] == "error":
                        raise SystemExit(f"server error: {msg}")
            ws.send(json.dumps({"type": "stop"}))
            while True:
                msg = json.loads(ws.recv())
                if msg["type"] == "vitals":
                    vitals_messages.append(msg)
                if msg["type"] == "stopped":
                    perf = msg["perf"]
                    break
        uv.should_exit = True
        thread.join(timeout=10)
        factory.close()          # it pre-loads a spare pipeline for the next phone

    elapsed = time.perf_counter() - start
    dropped = [a for a in acks if a.get("dropped")]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    recorder.vitals_messages = vitals_messages
    recorder.save(args.out, {"code_dir": ROOT, "hr": args.hr, "video": args.video,
                             "frames": len(recorder.frames), "elapsed_s": elapsed,
                             "runner": f"backend ({args.transport}, {args.encoding})",
                             "acks": acks, "vitals_messages": vitals_messages, "perf": perf})
    print(f"{len(recorder.frames)} frames processed, {len(dropped)} dropped, "
          f"{len(vitals_messages)} vitals messages in {elapsed:.1f} s -> {args.out}")
    if perf:
        print("server perf:", json.dumps(perf))


if __name__ == "__main__":
    main()

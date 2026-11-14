"""Replay a recording made with `python app.py --record session.csv`.

Feeds the saved per-frame signals through vitals.py exactly as the live app
does, so you can change filters or thresholds and re-check accuracy without
re-recording. Prints the app's readings every 5 s and at every 'm' mark.

Usage:
    python replay.py session.csv
"""
import csv
import sys

from vitals import HeartRateEstimator, RespirationEstimator

UPDATE_EVERY_SEC = 0.5


def main(path):
    heart = HeartRateEstimator()
    breathing = RespirationEstimator(channel_names=("chest", "head"))
    last_update = last_print = -1e9
    bpm = rr = None
    print(f"{'time_s':>7} {'heart':>7} {'snr_db':>7} {'agree':>5} {'breath':>7} {'source':>6}  mark")
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            t = float(row["t"])
            heart.add(t, [float(row[f"{c}{r}"]) for r in range(3) for c in "rgb"])
            breathing.add(t, [float(row["chest"]), float(row["head"])])
            if t - last_update >= UPDATE_EVERY_SEC:
                last_update = t
                bpm, rr = heart.update(), breathing.update()
            marked = row["mark"] == "1"
            if marked or t - last_print >= 5.0:
                last_print = t
                snr = f"{heart.snr_db:.1f}" if heart.snr_db is not None else "--"
                hr_text = f"{bpm:.0f}" if bpm is not None else "--"
                rr_text = f"{rr:.1f}" if rr is not None else "--"
                print(f"{t:7.1f} {hr_text:>7} {snr:>7} {str(heart.regions_agree):>5} "
                      f"{rr_text:>7} {str(breathing.channel_name):>6}  {'<-- mark' if marked else ''}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python replay.py session.csv")
    main(sys.argv[1])

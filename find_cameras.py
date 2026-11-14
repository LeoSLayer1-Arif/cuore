"""Show one picture from each camera so you can tell which number is which.

Run:  python find_cameras.py
Press any key in the picture window to move to the next camera.
"""
import sys

import cv2

backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
found = False

for index in range(6):
    cap = cv2.VideoCapture(index, backend)
    if not cap.isOpened():
        continue
    for _ in range(10):              # the first frames are often black while the camera starts
        ok, frame = cap.read()
    cap.release()
    if not ok:
        continue
    found = True
    height, width = frame.shape[:2]
    print(f"Camera {index}: {width}x{height}. Press any key in the window for the next camera.")
    title = f"Camera {index}"
    cv2.imshow(title, frame)
    cv2.waitKey(0)
    cv2.destroyWindow(title)

if not found:
    print("No cameras found.")
else:
    print("Done. Run the app with:  python app.py --camera NUMBER")

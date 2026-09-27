"""30 FPS camera-only JPEG stream, with one latest-frame slot over paired SSH."""
from __future__ import annotations

import argparse
import json
import math
import signal
import sys
import threading
import time

from .camera import CameraFrame, LatestFrameBuffer


def focus_and_lock(camera, controls):
    """Focus once before streaming; preserve lens geometry until explicit reconnect."""
    succeeded = bool(camera.wait(camera.autofocus_cycle(wait=False), timeout=7))
    position = camera.capture_metadata()['LensPosition']
    if type(position) not in (int, float) or not math.isfinite(position) or not 0 <= position <= 100:
        raise RuntimeError('Camera did not report a valid focus position.')
    camera.set_controls({'AfMode': controls.AfModeEnum.Manual, 'LensPosition': position})
    # Discard frames still using controls queued before manual focus was applied.
    stable = 0
    for _ in range(12):
        metadata = camera.capture_metadata()
        stable = stable + 1 if (metadata.get('AfState') != controls.AfStateEnum.Scanning
                               and abs(metadata['LensPosition'] - position) < 0.02) else 0
        if stable >= 4:
            return float(position), succeeded
    raise RuntimeError('Camera did not lock its focus. Reconnect before aiming.')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable-camera', action='store_true')
    args = parser.parse_args()
    if not args.enable_camera:
        parser.error('Camera capture requires explicit opt-in.')
    from picamera2 import Picamera2
    from picamera2.encoders import MJPEGEncoder
    from picamera2.outputs import Output
    from libcamera import controls

    done = threading.Event()
    frames = LatestFrameBuffer()
    encoder = MJPEGEncoder(framerate=30, qp=5)

    class LatestOutput(Output):
        def __init__(self):
            super().__init__()
            self.sequence = 0

        def outputframe(self, frame, keyframe=True, timestamp=None, packet=None, audio=False):
            if not self.recording or audio or timestamp is None or encoder.firsttimestamp is None:
                return
            captured = (encoder.firsttimestamp + timestamp) / 1_000_000
            if not 0 <= time.monotonic() - captured <= 0.5:
                return
            self.sequence += 1
            frames.publish(CameraFrame(f'pi-{self.sequence}', captured, bytes(frame), 'locked-focus-hd'))

    def stop(*_):
        done.set()
    def watch_stdin():
        while sys.stdin.buffer.read(1):
            pass
        done.set()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    threading.Thread(target=watch_stdin, daemon=True).start()
    camera = Picamera2()
    recording = False
    try:
        camera.configure(camera.create_video_configuration(
            main={'size': (1280, 720), 'format': 'YUV420'}, buffer_count=6,
            controls={'FrameRate': 30.0, 'AfMode': controls.AfModeEnum.Manual, 'LensPosition': 3.0,
                      'Sharpness': 1.5}))
        camera.start()
        focus, focused = focus_and_lock(camera, controls)
        camera.start_encoder(encoder, LatestOutput())
        recording = True
        while not done.is_set():
            frame = frames.take_latest(timeout_s=0.2)
            if frame is None:
                continue
            if time.monotonic() - frame.captured_monotonic_s > 0.5:
                continue
            header = {'protocol': 3, 'length': len(frame.jpeg), 'frame_id': frame.frame_id,
                      'focus_dioptres': focus, 'focus_locked': True, 'focus_success': focused,
                      'capture_s': frame.captured_monotonic_s, 'send_s': time.monotonic()}
            sys.stdout.buffer.write(json.dumps(header, separators=(',', ':')).encode() + b'\n')
            sys.stdout.buffer.write(frame.jpeg)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        pass
    finally:
        done.set()
        if recording:
            camera.stop_encoder()
        camera.stop()
        camera.close()
        frames.close()


if __name__ == '__main__':
    main()

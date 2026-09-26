# Local visual point tracking

`ohmpath.vision.tracking.VisualTracker` is a bounded software component for camera-frame quality metrics and a **user-selected pixel point**. It does not identify a component, infer electrical connectivity, calibrate a camera, make a measurement, or authorize a physical action. Its coordinates belong only to the decoded frame that supplied them.

The caller creates one tracker and passes frames through:

```python
tracker.process(
    context_id="canonical-uuid", source="overview", sequence=1,
    image=jpeg_or_png_bytes, point=(0.5, 0.5), now=None,
)
tracker.reset(context_id)
```

`point` is an explicit normalized `(x, y)` selection. With no selection, the first frame is `idle`. A sufficiently detailed selected patch returns `tracking` and a normalized `target`. Later ordered frames search at most 48 pixels around the previous position for the original 33 × 33 pixel patch. A weak, ambiguous, obscured, out-of-view, or stale match returns `lost` with `target: null`. Once lost, later images cannot reacquire the point until the user selects it again. A source or resolution change also loses the previous target; a new explicit point may seed the new frame. `reset` discards the context.

The return shape is `{context_id, source, sequence, status, target, quality, message}`. `status` is `tracking`, `lost`, or `idle`. `quality` contains bounded 0–1 `brightness`, `contrast`, `sharpness`, `texture`, and `match` heuristics. These are display/diagnostic metrics, **not probabilities or confidence that a circuit part was identified**. The tracker holds only the small selected template and state in memory; no frame, image, or measurement is returned or persisted.

Input limits are two active contexts, canonical UUIDs, `overview` or `pi` source, strictly increasing positive sequence up to 2,147,483,647, 8-bit non-interlaced PNG or JPEG bytes up to 512 KiB, and declared/decoded dimensions at most 1280 × 960. Headers and dimensions are checked before OpenCV decoding. Bad inputs or out-of-order frames raise `ValueError`; a point near an image edge or on a low-detail patch returns `lost`. More than two seconds between a context's frames loses its target. When a third context arrives, only already expired other contexts may be discarded to make room. Calls and reset are serialized inside the tracker.

Synthetic tests cover translated textured imagery, JPEG and PNG, blank/occluded/unrelated views, a large jump, low-detail and edge selections, source/resolution/context changes, stale or out-of-order frames, oversized or incomplete images, and target loss without implicit reacquisition. On this development laptop, 12 synthetic 1280 × 960 JPEG frames processed in 0.026 seconds total (2.2 ms per frame) in one short test run. This is a local CPU measurement, not a sustained camera-rate, latency, thermal, or physical accuracy claim. Real camera acceptance still needs held-out scenes, blur/glare/lighting changes, and measured throughput alongside the rest of the application.

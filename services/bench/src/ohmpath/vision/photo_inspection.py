"""Bounded close-up inspection of already selected, frozen photos.

This is local image preparation, not an electrical/component classifier. It
does not read resistor values, recover missing pixels, or open any camera.
"""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path

import cv2
import numpy as np

from ohmpath.session.store import DomainError

MAX_INSPECTIONS = 2
MAX_CROP_BYTES = 150_000
INSPECT_PHOTO_TOOL = {
    "type": "function",
    "name": "inspect_photo_region",
    "description": (
        "Inspect a close-up from a currently selected photo, without another camera capture. "
        "Choose the resistor body/marking or obscured connection with some surrounding context. "
        "Returns unchanged-color pixels, image-quality hints and the original-image coordinate "
        "mapping. This cannot recover unreadable bands or confirm hidden electrical connections. "
        "At most two inspections per question."
    ),
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "properties": {
            "image_id": {"type": "string"},
            "region": {
                "type": "object", "additionalProperties": False,
                "properties": {key: {"type": "number", "minimum": 0, "maximum": 1}
                               for key in ("x", "y", "width", "height")},
                "required": ["x", "y", "width", "height"],
            },
        },
        "required": ["image_id", "region"],
    },
}


def _failure(reason: str) -> dict:
    return {"success": False, "contentItems": [{"type": "inputText", "text": reason}]}


class PhotoInspector:
    """Only registered temporary images are accessible; requests cannot supply paths."""

    def __init__(self, images: list[tuple[str, Path]]):
        if not 1 <= len(images) <= 3 or len({key for key, _ in images}) != len(images):
            raise ValueError("Invalid selected photo set.")
        self.images = dict(images)
        self.calls = 0

    def inspect(self, arguments: dict) -> dict:
        if self.calls >= MAX_INSPECTIONS:
            return _failure("photo_inspection_limit: Ask for a clearer physical view if details remain unreadable.")
        self.calls += 1
        if not isinstance(arguments, dict) or set(arguments) != {"image_id", "region"}:
            return _failure("invalid_photo_region")
        image_id, region = arguments["image_id"], arguments["region"]
        if not isinstance(image_id, str) or image_id not in self.images:
            return _failure("unknown_current_image")
        if not isinstance(region, dict) or set(region) != {"x", "y", "width", "height"}:
            return _failure("invalid_photo_region")
        if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v)
               or not 0 <= v <= 1 for v in region.values()):
            return _failure("invalid_photo_region")
        x, y, w, h = (region[key] for key in ("x", "y", "width", "height"))
        if w <= 0 or h <= 0 or x + w > 1.000000001 or y + h > 1.000000001:
            return _failure("invalid_photo_region")
        try:
            path = Path(self.images[image_id])
            if not path.is_absolute() or path.is_symlink() or not 16 <= path.stat().st_size <= 2_000_000:
                return _failure("photo_inspection_unavailable")
            raw = path.read_bytes()
            # Reuse the photo API's bounded header/decompression validation.
            # Lazy import avoids an import cycle with the runtime dispatcher.
            from ohmpath.ai.photo_help import _jpeg_dimensions, _png_dimensions

            width, height = (_png_dimensions(raw) if raw.startswith(b"\x89PNG") else _jpeg_dimensions(raw))
            frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None or frame.shape[:2] != (height, width):
                return _failure("photo_inspection_unavailable")
            left, top = math.floor(x * width), math.floor(y * height)
            right, bottom = min(width, math.ceil((x + w) * width)), min(height, math.ceil((y + h) * height))
            if right - left < 8 or bottom - top < 8:
                return _failure("photo_region_too_small: Request a closer physical photo; digital enlargement adds no detail.")
            crop = frame[top:bottom, left:right]
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            brightness = float(gray.mean())
            edge_energy = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            hints = []
            if min(crop.shape[:2]) < 40:
                hints.append("Few source pixels: request a closer perpendicular photo before reading fine bands or text.")
            if brightness < 45:
                hints.append("Region is dark: improve diffuse lighting and take another photo if markings are unclear.")
            if edge_energy < 20:
                hints.append("Region has little edge detail; this can mean blur or a blank surface. Ask for focus/closer view if needed.")
            original_shape = crop.shape[:2]
            factor = min(1.0, 640 / max(original_shape))
            if factor < 1:
                crop = cv2.resize(crop, (max(8, round(crop.shape[1] * factor)),
                                        max(8, round(crop.shape[0] * factor))), interpolation=cv2.INTER_AREA)
            # Lossless PNG preserves colors at the delivered scale; no artificial
            # sharpening, contrast/color shifts or upsampling invents band detail.
            for _ in range(6):
                ok, encoded = cv2.imencode(".png", crop, [cv2.IMWRITE_PNG_COMPRESSION, 6])
                if ok and encoded.nbytes <= MAX_CROP_BYTES:
                    break
                crop = cv2.resize(crop, (max(8, int(crop.shape[1] * .75)),
                                        max(8, int(crop.shape[0] * .75))), interpolation=cv2.INTER_AREA)
            else:
                return _failure("photo_region_too_complex")
            metadata = {
                "image_id": image_id,
                "source_region": {"x": left / width, "y": top / height,
                                  "width": (right - left) / width, "height": (bottom - top) / height},
                "source_pixels": {"width": right - left, "height": bottom - top},
                "delivered_pixels": {"width": crop.shape[1], "height": crop.shape[0]},
                "resized_down": crop.shape[:2] != original_shape,
                "quality_hints": hints,
                "interpretation": (
                    "Same frozen photo, not new evidence. Identify each band/marking only when readable. "
                    "Leave unknown values and hidden connections unresolved and ask a part-specific question. "
                    "All final annotations use ORIGINAL image coordinates: original x=region.x+crop_x*region.width "
                    "and original y=region.y+crop_y*region.height. A crop does not confirm a value or connectivity."
                ),
            }
            return {"success": True, "contentItems": [
                {"type": "inputText", "text": json.dumps(metadata, separators=(",", ":"))},
                {"type": "inputImage", "imageUrl": "data:image/png;base64," + base64.b64encode(encoded).decode("ascii")},
            ]}
        except (OSError, ValueError, DomainError, cv2.error):
            return _failure("photo_inspection_unavailable")

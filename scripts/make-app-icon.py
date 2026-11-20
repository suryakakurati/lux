#!/usr/bin/env python3
"""Draw Lux's application icon (1024 px master) with no image libraries.

A paper rounded-square holding a crimson ring and core — the same mark as the
HUD orb, so the app icon and the listening state read as one object.
"""
import struct
import zlib
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "resources" / "app-icon.png"

PAPER = (240, 240, 242)
WINE = (80, 20, 35)
CRIMSON = (184, 47, 76)
BLUSH = (244, 182, 192)


def rounded_square(x: float, y: float, radius: float) -> bool:
    """True when (x, y) in 0..SIZE is inside a squared rect of the given radius."""
    m = SIZE * 0.055
    left, top, right, bottom = m, m, SIZE - m, SIZE - m
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    inside_rect = left <= x <= right and top <= y <= bottom
    return inside_rect and (x - cx) ** 2 + (y - cy) ** 2 <= radius**2 + 1e-9


def blend(dst, src, alpha):
    return tuple(int(round(dst[i] * (1 - alpha) + src[i] * alpha)) for i in range(3))


def main() -> None:
    pixels = bytearray(SIZE * SIZE * 4)
    centre = (SIZE - 1) / 2
    for y in range(SIZE):
        for x in range(SIZE):
            index = (y * SIZE + x) * 4
            if not rounded_square(x, y, SIZE * 0.2):
                continue
            colour = PAPER
            dist = ((x - centre) ** 2 + (y - centre) ** 2) ** 0.5
            # Soft edge on the paper square.
            edge = min(x, y, SIZE - 1 - x, SIZE - 1 - y)
            paper_alpha = 1.0
            if edge < SIZE * 0.055 + 1.5:
                paper_alpha = max(0.0, (edge - (SIZE * 0.055 - 1.5)) / 3)
            if paper_alpha <= 0:
                continue

            if 296 <= dist <= 350:
                colour = WINE
            elif 218 <= dist < 296:
                colour = BLUSH
            elif dist < 96:
                colour = CRIMSON
            elif dist < 104:
                colour = blend(PAPER, CRIMSON, 0.35)

            pixels[index : index + 4] = bytes(
                (colour[0], colour[1], colour[2], int(255 * paper_alpha))
            )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + bytes(pixels[y * SIZE * 4 : (y + 1) * SIZE * 4]) for y in range(SIZE))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    OUT.write_bytes(png)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

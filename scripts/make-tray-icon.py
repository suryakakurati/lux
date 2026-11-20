#!/usr/bin/env python3
"""Draw Lux's menu-bar glyph as a template PNG (no third-party libraries).

A template image is a black glyph on transparency; macOS recolours it for light
and dark menu bars. Two sizes are written so Retina displays stay crisp.
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "resources"


def png(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + pixels[y * width * 4 : (y + 1) * width * 4] for y in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def glyph(size: int) -> bytes:
    """A ring with a filled centre dot — the Lux mark, drawn analytically."""
    pixels = bytearray(size * size * 4)
    centre = (size - 1) / 2
    outer = size * 0.46
    inner = size * 0.31
    dot = size * 0.15
    for y in range(size):
        for x in range(size):
            distance = ((x - centre) ** 2 + (y - centre) ** 2) ** 0.5
            alpha = 0
            if inner <= distance <= outer:
                alpha = 255
            elif distance <= dot:
                alpha = 255
            # Soft edge so the glyph does not look jagged at 1x.
            elif outer < distance <= outer + 0.8:
                alpha = int(255 * (1 - (distance - outer) / 0.8))
            index = (y * size + x) * 4
            pixels[index : index + 4] = bytes((0, 0, 0, alpha))
    return bytes(pixels)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "trayTemplate.png").write_bytes(png(18, 18, glyph(18)))
    (OUT / "trayTemplate@2x.png").write_bytes(png(36, 36, glyph(36)))
    print(f"wrote {OUT / 'trayTemplate.png'} and @2x")


if __name__ == "__main__":
    main()

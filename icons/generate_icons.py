#!/usr/bin/env python3
"""
MailBoost icon generator.

Draws the ⚡ MailBoost mark (a white lightning bolt on an Outlook-blue
rounded square) at 16x16, 48x48 and 128x128 and writes real PNG files.
Pure standard library -- no Pillow, no node-canvas, no install step.

This is a *placeholder*, not commissioned artwork -- see README.md for
guidance on replacing it before a Chrome Web Store submission. It is drawn
with a bit more depth than a single flat fill: a diagonal gradient, a soft
top-left highlight, and a drop shadow tucked under the bolt. The 16px icon
deliberately skips all of that and renders flat -- fine detail disappears
at that size, and a toolbar-scale icon needs contrast more than polish.

Usage:  python3 icons/generate_icons.py
"""

import struct
import zlib
from pathlib import Path

# Gradient endpoints, built by lightening/darkening the brand blue #0078D4
# so the mid-gradient tone still reads as "Outlook blue" at a glance.
BRAND = (0x00, 0x78, 0xD4)
BG_LIGHT = (0x28, 0xA0, 0xFC)   # top-left
BG_DARK = (0x00, 0x50, 0xAC)    # bottom-right
FG = (0xFF, 0xFF, 0xFF)         # bolt white
SHADOW = (0x00, 0x28, 0x50)     # tucked under the bolt's lower-right edge
SHADOW_ALPHA = 0.32
HIGHLIGHT_ALPHA = 0.16

# Lightning bolt outline in a 0..1 unit square, traced clockwise.
BOLT = [
    (0.56, 0.06), (0.24, 0.56), (0.46, 0.56), (0.38, 0.94),
    (0.74, 0.42), (0.50, 0.42), (0.60, 0.06),
]

# How far the drop shadow is offset from the bolt, as a fraction of icon size.
SHADOW_OFFSET = 0.035


def point_in_polygon(x, y, poly):
    """Standard ray-casting test."""
    inside = False
    j = len(poly) - 1
    for i, (xi, yi) in enumerate(poly):
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def inside_rounded_rect(x, y, size, radius):
    """True when (x, y) falls inside a rounded square of the given size."""
    r = radius
    if r <= 0:
        return True
    for cx, cy in ((r, r), (size - r, r), (r, size - r), (size - r, size - r)):
        # Only the four corner quadrants need the circle test.
        if (x < r or x > size - r) and (y < r or y > size - r):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                return True
        elif (x < r or x > size - r) or (y < r or y > size - r):
            continue
    if r <= x <= size - r or r <= y <= size - r:
        return True
    return False


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def blend(base, over, alpha):
    """Alpha-composite `over` onto `base`."""
    return tuple(round(base[i] * (1 - alpha) + over[i] * alpha) for i in range(3))


def background_color(x, y, size, gradient):
    if not gradient:
        return BRAND
    t = max(0.0, min(1.0, (x + y) / (2 * size)))
    color = lerp(BG_LIGHT, BG_DARK, t)

    # Soft elliptical highlight in the upper-left, simulating a light glass
    # sheen without going full skeuomorphic.
    nx, ny = x / size - 0.24, y / size - 0.20
    dist = ((nx / 0.55) ** 2 + (ny / 0.45) ** 2) ** 0.5
    if dist < 1.0:
        falloff = (1.0 - dist) ** 1.6
        color = blend(color, (255, 255, 255), HIGHLIGHT_ALPHA * falloff)
    return color


def bolt_color(y, size, gradient):
    if not gradient:
        return FG
    # A very subtle top-white to pale-blue gradient down the bolt, just
    # enough to keep it from looking like a flat sticker.
    return lerp((255, 255, 255), (222, 240, 255), y / size)


def render(size, gradient=True, samples=4):
    """Return raw RGBA rows for one icon, supersampled for smooth edges."""
    radius = max(2, size * 0.23)
    dx = dy = SHADOW_OFFSET * size
    rows = []

    for py in range(size):
        row = bytearray()
        for px in range(size):
            hits = 0
            r_sum = g_sum = b_sum = 0

            for sy in range(samples):
                for sx in range(samples):
                    x = px + (sx + 0.5) / samples
                    y = py + (sy + 0.5) / samples
                    if not inside_rounded_rect(x, y, size, radius):
                        continue
                    hits += 1

                    ux, uy = x / size, y / size
                    in_bolt = point_in_polygon(ux, uy, BOLT)

                    if in_bolt:
                        c = bolt_color(y, size, gradient)
                    else:
                        c = background_color(x, y, size, gradient)
                        if gradient:
                            in_shadow = point_in_polygon(
                                (x - dx) / size, (y - dy) / size, BOLT
                            )
                            if in_shadow:
                                c = blend(c, SHADOW, SHADOW_ALPHA)

                    r_sum += c[0]
                    g_sum += c[1]
                    b_sum += c[2]

            total = samples * samples
            if hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            alpha = round(255 * hits / total)
            row += bytes((
                round(r_sum / hits), round(g_sum / hits), round(b_sum / hits), alpha
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, gradient=True, samples=4):
    rows = render(size, gradient=gradient, samples=samples)
    raw = b"".join(b"\x00" + r for r in rows)   # filter byte 0 per scanline

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    Path(path).write_bytes(png)
    print(f"wrote {path} ({size}x{size}, {len(png)} bytes)")


if __name__ == "__main__":
    here = Path(__file__).parent
    # 16px stays flat and high-contrast -- gradient/shadow detail just
    # turns to mud at toolbar scale. 48/128 get the fuller treatment.
    write_png(here / "icon16.png", 16, gradient=False, samples=4)
    write_png(here / "icon48.png", 48, gradient=True, samples=4)
    write_png(here / "icon128.png", 128, gradient=True, samples=4)

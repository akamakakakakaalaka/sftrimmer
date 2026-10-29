"""Reproduce the original geometric app icon; Python standard library only."""
from pathlib import Path
import struct
import zlib

SIZE = 1024
pixels = bytearray(SIZE * SIZE * 3)
for y in range(SIZE):
    for x in range(SIZE):
        offset = (y * SIZE + x) * 3
        glow = max(0, 1 - ((x - 340) ** 2 + (y - 200) ** 2) / 800_000)
        pixels[offset:offset + 3] = bytes((int(15 + glow * 10), int(24 + glow * 12), int(36 + glow * 14)))


def rectangle(left, top, right, bottom, color, radius=0):
    for y in range(top, bottom):
        for x in range(left, right):
            dx = max(left + radius - x, 0, x - (right - radius - 1))
            dy = max(top + radius - y, 0, y - (bottom - radius - 1))
            if dx * dx + dy * dy <= radius * radius:
                offset = (y * SIZE + x) * 3
                pixels[offset:offset + 3] = bytes(color)


# A compact octave with an ascending pulse above it. No borrowed logo or font.
for index, height in enumerate((70, 120, 185, 120, 70)):
    x = 300 + index * 90
    rectangle(x, 350 - height, x + 46, 350, (207, 181, 124), 20)
rectangle(182, 410, 842, 812, (44, 54, 67), 38)
for index in range(7):
    left = 205 + index * 89
    rectangle(left, 434, left + 77, 789, (235, 231, 217), 11)
for index in (0, 1, 3, 4, 5):
    left = 254 + index * 89
    rectangle(left, 434, left + 54, 640, (17, 26, 39), 8)


def chunk(name, data):
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xFFFFFFFF)


raw = b''.join(b'\x00' + pixels[row * SIZE * 3:(row + 1) * SIZE * 3] for row in range(SIZE))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
path = Path(__file__).parent / 'Project128/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
path.write_bytes(png)
print(f'{path.name}: {len(png)} bytes, RGB {SIZE}×{SIZE}')

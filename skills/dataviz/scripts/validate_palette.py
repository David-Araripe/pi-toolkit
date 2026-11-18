#!/usr/bin/env python3
"""Validate chart colors for surface contrast and approximate CVD separation.

Uses only the Python standard library. CVD checks apply full-severity Machado-style
linear-RGB simulations and CIE76 distance. This is a practical screening check,
not a substitute for inspecting the rendered chart or using secondary encodings.
"""

from __future__ import annotations

import argparse
import math
import re
import sys

SURFACES = {"light": "#fcfcfb", "dark": "#1a1a19"}
CVD_MATRICES = {
    "protan": (
        (0.152286, 1.052583, -0.204868),
        (0.114503, 0.786281, 0.099216),
        (-0.003882, -0.048116, 1.051998),
    ),
    "deutan": (
        (0.367322, 0.860646, -0.227968),
        (0.280085, 0.672501, 0.047413),
        (-0.011820, 0.042940, 0.968881),
    ),
    "tritan": (
        (1.255528, -0.076749, -0.178779),
        (-0.078411, 0.930809, 0.147602),
        (0.004733, 0.691367, 0.303900),
    ),
}


def parse_hex(value: str) -> tuple[float, float, float]:
    value = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        value = "#" + "".join(ch * 2 for ch in value[1:])
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError(f"invalid hex color: {value!r}")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def linear_channel(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def linear_rgb(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(linear_channel(c) for c in rgb)  # type: ignore[return-value]


def luminance(rgb: tuple[float, float, float]) -> float:
    r, g, b = linear_rgb(rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def transform(rgb: tuple[float, float, float], matrix) -> tuple[float, float, float]:
    values = linear_rgb(rgb)
    return tuple(max(0.0, min(1.0, sum(row[i] * values[i] for i in range(3)))) for row in matrix)  # type: ignore[return-value]


def lab_from_linear(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    r, g, b = rgb
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def f(v: float) -> float:
        delta = 6 / 29
        return v ** (1 / 3) if v > delta**3 else v / (3 * delta**2) + 4 / 29

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def separation(a, b) -> tuple[float, str]:
    distances = []
    labels = ["normal", *CVD_MATRICES]
    variants_a = [linear_rgb(a), *(transform(a, m) for m in CVD_MATRICES.values())]
    variants_b = [linear_rgb(b), *(transform(b, m) for m in CVD_MATRICES.values())]
    for label, va, vb in zip(labels, variants_a, variants_b):
        distances.append((delta_e(lab_from_linear(va), lab_from_linear(vb)), label))
    return min(distances)


def status(value: float, fail: float, warn: float) -> str:
    return "PASS" if value >= warn else "WARN" if value >= fail else "FAIL"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("palette", nargs="+", help="Comma-separated hex colors, or colors as separate arguments")
    parser.add_argument("--mode", choices=("light", "dark"), default="light")
    parser.add_argument("--surface", help="Override the mode's chart surface")
    args = parser.parse_args()

    names = [item.strip() for arg in args.palette for item in arg.split(",") if item.strip()]
    if len(names) < 1:
        parser.error("provide at least one color")
    try:
        colors = [parse_hex(name) for name in names]
        surface_name = args.surface or SURFACES[args.mode]
        surface = parse_hex(surface_name)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    failed = False
    print(f"Surface: {surface_name} ({args.mode})")
    print("\nMark contrast (3:1 target; 2:1 minimum for large marks):")
    for name, color in zip(names, colors):
        ratio = contrast(color, surface)
        result = status(ratio, 2.0, 3.0)
        failed |= result == "FAIL"
        print(f"  {name:>8}  {ratio:5.2f}:1  {result}")

    if len(colors) > 1:
        print("\nAdjacent categorical separation (CIE76 after CVD simulation):")
        for i in range(len(colors) - 1):
            distance, condition = separation(colors[i], colors[i + 1])
            result = status(distance, 8.0, 12.0)
            failed |= result == "FAIL"
            print(f"  {names[i]:>8} → {names[i + 1]:<8}  ΔE {distance:5.1f}  {result} ({condition})")

    print("\nPASS is a screening result. Also inspect the render and avoid color-only encoding.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

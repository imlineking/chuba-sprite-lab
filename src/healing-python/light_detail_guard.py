"""Conservative light-detail recovery over an already detected neutral grid.

This is an opt-in candidate stage. RGB is copied from neighboring artwork only
inside repaired seams; approved/robust Healing Tool profiles are unchanged.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from final_cleaner_lab import components


def _closed(mask: np.ndarray, size: int = 9) -> np.ndarray:
    image = Image.fromarray(mask.astype('uint8') * 255)
    return np.asarray(image.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))) > 0


def recover_light_details(source: np.ndarray, cutout: np.ndarray, structure: dict):
    """Protect coherent cream/light texture against a neutral checkerboard.

    The neutral palette is learned by structural checker detection upstream.
    Cream/light artwork has a warm residual from the achromatic palette. We
    require thick regions somewhere in the image rather than only thin fringes.
    Hidden RGB is raised only when that warm texture has a broad hidden core.
    This avoids revealing anti-aliased checker fragments around intact objects.
    """
    if source.shape != cutout.shape or source.dtype != np.uint8:
        raise ValueError('Expected matching uint8 RGBA images')
    result = cutout.copy()
    h, w = source.shape[:2]
    masks = {name: np.zeros((h, w), bool) for name in ('preserved-visible', 'restored-hidden', 'filled-holes', 'recolored-seams')}
    report = {'enabled': False, 'reason': 'No confirmed bright neutral checker'}
    modes = structure.get('learnedBoundaryValues')
    if not structure.get('found') or not modes or len(modes) != 2:
        return result, masks, report
    modes = np.asarray(modes, dtype=float)
    if np.ptp(modes, axis=1).max() > 4 or modes.min() < 180:
        return result, masks, report

    rgb = source[:, :, :3].astype(np.int16)
    brightness = rgb.min(axis=2)
    warmth = rgb[:, :, 0] - rgb[:, :, 2]
    # The confirmed grid is achromatic. Cream artwork retains a small warm
    # residual even where it is almost as light as the white grid tile.
    seed = (warmth >= 5) & (brightness >= 190)
    count = int(seed.sum())
    if count < 32:
        return result, masks, {'enabled': False, 'reason': 'No supported light-detail texture', 'seedPixels': count}
    source_alpha = source[:, :, 3]
    visible_seed = seed & (source_alpha > 0)
    hidden_seed = seed & (source_alpha == 0)
    visible_core = np.asarray(Image.fromarray(visible_seed.astype('uint8') * 255).filter(ImageFilter.MinFilter(5))) > 0
    hidden_core = np.asarray(Image.fromarray(hidden_seed.astype('uint8') * 255).filter(ImageFilter.MinFilter(5))) > 0
    visible_core_fraction = float(visible_core.sum() / max(1, visible_seed.sum()))
    hidden_core_fraction = float(hidden_core.sum() / max(1, hidden_seed.sum()))
    # Thin colored fringe can have many pixels but almost no 5x5 interior.
    # Require a coherent light body before protecting any pixel.
    if max(visible_core_fraction, hidden_core_fraction) < .1 or max(int(visible_core.sum()), int(hidden_core.sum())) < 100:
        return result, masks, {'enabled': False, 'reason': 'Light residual is fringe, not a coherent body',
                               'seedPixels': count, 'visibleCoreFraction': round(visible_core_fraction, 4),
                               'hiddenCoreFraction': round(hidden_core_fraction, 4)}
    core = visible_core | hidden_core
    near_core = np.asarray(Image.fromarray(core.astype('uint8') * 255).filter(ImageFilter.MaxFilter(17))) > 0
    detail = (seed | _closed(seed)) & (brightness >= 190)
    alpha = result[:, :, 3]

    # The light body's original one-pixel contour is often much darker than
    # its interior. Keeping only >=190 cuts a black-looking groove around
    # restored petals and punches holes through beige mushroom spots.
    hidden_seed_fraction = float((seed & (source_alpha == 0)).sum() / count)
    # This is a recovery signal, not a universal rule that hidden RGB is art.
    # A broad hidden petal retains a thick tinted core. A thin resampling fringe
    # around intact mushrooms/leaves does not, even if most warm fringe is hidden.
    recover_hidden = hidden_seed_fraction >= .5 and hidden_core_fraction >= .1 and int(hidden_core.sum()) >= 100

    original_contour = (warmth >= 5) & (brightness >= 130) & near_core
    preserve_candidate = (detail | original_contour) & (source_alpha > alpha)
    if not recover_hidden:
        # Morphological closing bridges neutral checker tiles between nearby
        # cream objects. On a mostly intact object preserve only pixels with
        # their own warm residual, including darker cream texture.
        preserve_candidate = (warmth >= 5) & (brightness >= 100) & (source_alpha > alpha)
    preserved = preserve_candidate
    alpha[preserved] = source_alpha[preserved]
    masks['preserved-visible'] = preserved
    if recover_hidden:
        hidden = detail & near_core & (source_alpha == 0) & (alpha == 0)
        alpha[hidden] = 255
        masks['restored-hidden'] = hidden

    # A white artwork patch can contain one square whose RGB exactly matches a
    # background tile. Fill only small enclosed holes with a bright tinted ring;
    # a gap between green leaves or mushroom stems does not have such a ring.
    visible = alpha > 0
    labels = components(~visible)
    counts = np.bincount(labels.ravel())
    ys, xs = np.nonzero(~visible)
    at = labels[ys, xs]
    minx = np.full(len(counts), w)
    maxx = np.zeros(len(counts), int)
    miny = np.full(len(counts), h)
    maxy = np.zeros(len(counts), int)
    np.minimum.at(minx, at, xs)
    np.maximum.at(maxx, at, xs)
    np.minimum.at(miny, at, ys)
    np.maximum.at(maxy, at, ys)
    upper = min(256, int(1.25 * structure.get('cell', 16) ** 2))
    for label in np.flatnonzero((counts >= 8) & (counts <= upper)):
        if label == 0:
            continue
        x0, x1 = int(minx[label]), int(maxx[label] + 1)
        y0, y1 = int(miny[label]), int(maxy[label] + 1)
        if x0 == 0 or y0 == 0 or x1 == w or y1 == h:
            continue
        if not .6 <= (x1 - x0) / (y1 - y0) <= 1.6:
            continue
        sx = slice(x0 - 1, x1 + 1)
        sy = slice(y0 - 1, y1 + 1)
        patch = labels[sy, sx] == label
        if float((brightness[sy, sx][patch] >= 190).mean()) < .95:
            continue
        dilated = np.asarray(Image.fromarray(patch.astype('uint8') * 255).filter(ImageFilter.MaxFilter(3))) > 0
        ring = dilated & ~patch & visible[sy, sx]
        if int(ring.sum()) < 8:
            continue
        ring_rgb = rgb[sy, sx][ring]
        ring_bright = np.min(ring_rgb, axis=1)
        if float(np.median(ring_bright)) < float(modes.max() - 10):
            continue
        warm_white = (ring_bright >= modes.max() - 50) & (np.ptp(ring_rgb, axis=1) <= 40) & ((ring_rgb[:, 0] - ring_rgb[:, 2]) >= 4)
        if float(warm_white.mean()) < .5:
            continue
        alpha[sy, sx][patch] = 255
        masks['filled-holes'][sy, sx][patch] = True

    # Join only sub-pixel seams inside or alongside light material. The
    # neutral RGB in a damaged white spot can be identical to a grid tile,
    # so color alone cannot decide it; local geometry supplies the evidence.
    visible = alpha >= 128 if recover_hidden else alpha > 0
    close_seams = _closed(visible, 11 if recover_hidden else 5) & ~visible
    light_support = (brightness >= 180) & (warmth >= 5) & visible
    near_light = np.asarray(Image.fromarray(light_support.astype('uint8') * 255).filter(ImageFilter.MaxFilter(5))) > 0
    recolored = np.zeros((h, w), bool)
    if recover_hidden:
        around_restoration = np.asarray(Image.fromarray(masks['restored-hidden'].astype('uint8') * 255).filter(ImageFilter.MaxFilter(31))) > 0
        seam = close_seams & around_restoration & (brightness >= 180)
    else:
        occupancy = np.asarray(Image.fromarray(visible.astype('uint8') * 255).filter(ImageFilter.BoxBlur(3))) / 255
        seam = close_seams & near_light & (brightness >= 180) & (source_alpha > 0) & (occupancy >= .65)
    if recover_hidden:
        for y, x in np.argwhere(seam & ((source_alpha < 128) | (warmth < 5))):
            y0, y1 = max(0, y - 5), min(h, y + 6)
            x0, x1 = max(0, x - 5), min(w, x + 6)
            yy, xx = np.nonzero(visible[y0:y1, x0:x1])
            if len(xx) == 0:
                continue
            ys, xs = yy + y0, xx + x0
            spatial = np.square(ys - y) + np.square(xs - x)
            color = np.square(result[ys, xs, :3].astype(np.int16) - rgb[y, x]).sum(axis=1)
            chosen = int(np.argmin(spatial * 100 + color))
            result[y, x, :3] = result[ys[chosen], xs[chosen], :3]
            recolored[y, x] = True
    alpha[seam] = 255
    masks['filled-holes'] |= seam

    if recover_hidden:
        # A restored petal can meet an already visible center across a narrow
        # neutral checker seam. Grow only into pixels mostly surrounded by
        # visible artwork, never into an open outer edge.
        restored_near = np.asarray(Image.fromarray(masks['restored-hidden'].astype('uint8') * 255).filter(ImageFilter.MaxFilter(7))) > 0
        for _ in range(2):
            visible = alpha >= 128
            padded = np.pad(visible, 1)
            neighbours = sum(padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
                             for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy)
            join = (~visible) & restored_near & (neighbours >= 5) & (brightness >= 180)
            for y, x in np.argwhere(join):
                options = []
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if (dy or dx) and 0 <= ny < h and 0 <= nx < w and visible[ny, nx]:
                            sample = result[ny, nx, :3].astype(np.int16)
                            distance = int(np.square(sample - rgb[y, x]).sum())
                            options.append((distance, -int(neighbours[ny, nx]), ny, nx))
                if options:
                    _, _, ny, nx = min(options)
                    result[y, x, :3] = result[ny, nx, :3]
                    recolored[y, x] = True
            alpha[join] = 255
            masks['filled-holes'] |= join

    if recover_hidden:
        # The neutral part of a white petal may be wider than a local seam.
        # Treat it as interior only when artwork bounds it from at least three
        # cardinal directions, with light artwork on two of those sides.
        visible = alpha >= 128
        light_visible = visible & (np.min(result[:, :, :3], axis=2) >= 180)
        sides = []
        light_sides = []
        for base, collector in ((visible, sides), (light_visible, light_sides)):
            up = np.zeros_like(base)
            down = np.zeros_like(base)
            left = np.zeros_like(base)
            right = np.zeros_like(base)
            for distance in range(1, 13):
                up[distance:] |= base[:-distance]
                down[:-distance] |= base[distance:]
                left[:, distance:] |= base[:, :-distance]
                right[:, :-distance] |= base[:, distance:]
            collector.extend((up, down, left, right))
        bounded = sum(s.astype(np.uint8) for s in sides) >= 3
        bounded_light = sum(s.astype(np.uint8) for s in light_sides) >= 2
        interior = (~visible) & around_restoration & bounded & bounded_light & (brightness >= 180)
        for y, x in np.argwhere(interior):
            y0, y1 = max(0, y - 12), min(h, y + 13)
            x0, x1 = max(0, x - 12), min(w, x + 13)
            yy, xx = np.nonzero(light_visible[y0:y1, x0:x1])
            if len(xx) == 0:
                continue
            ys, xs = yy + y0, xx + x0
            spatial = np.square(ys - y) + np.square(xs - x)
            color = np.square(result[ys, xs, :3].astype(np.int16) - rgb[y, x]).sum(axis=1)
            chosen = int(np.argmin(spatial * 100 + color))
            result[y, x, :3] = result[ys[chosen], xs[chosen], :3]
            alpha[y, x] = 255
            recolored[y, x] = True
            masks['filled-holes'][y, x] = True

        # A petal reconstructed from hidden RGB can still have a longer,
        # one-pixel seam along an old cut. The old 11px closing misses it.
        # Widen the search only inside a confirmed light body and require
        # surviving artwork on opposite sides before borrowing its color.
        visible = alpha >= 240
        light_body = visible & (np.min(result[:, :, :3], axis=2) >= 170) & (warmth >= 3)
        wider_seams = _closed(light_body, 25) & ~visible & around_restoration
        wider_seams &= (brightness >= 140) & (warmth >= 2)
        for y, x in np.argwhere(wider_seams):
            pairs = []
            for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
                sides = []
                for sign in (-1, 1):
                    for step in range(1, 13):
                        ny, nx = y + sign * step * dy, x + sign * step * dx
                        if not (0 <= ny < h and 0 <= nx < w):
                            break
                        if light_body[ny, nx]:
                            sides.append((step, ny, nx))
                            break
                if len(sides) == 2 and sum(item[0] for item in sides) <= 18:
                    pairs.extend(sides)
            if not pairs:
                continue
            _, ny, nx = min(pairs, key=lambda item: item[0])
            result[y, x, :3] = result[ny, nx, :3]
            alpha[y, x] = 255
            recolored[y, x] = True
            masks['filled-holes'][y, x] = True

        # The center has yellow and green texture, so a white-only donor
        # leaves dark pinholes there. Use intact pixels of the same local
        # material, still requiring a short, bracketed interior crossing.
        opaque = alpha >= 240
        near_petal = np.asarray(Image.fromarray(light_body.astype('uint8') * 255).filter(ImageFilter.MaxFilter(25))) > 0
        colored_seams = _closed(opaque, 17) & ~opaque & around_restoration & near_petal
        colored_seams &= (brightness >= 50) & ((np.ptp(rgb, axis=2) >= 12) | (warmth >= 2))
        for y, x in np.argwhere(colored_seams):
            pairs = []
            for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
                sides = []
                for sign in (-1, 1):
                    for step in range(1, 9):
                        ny, nx = y + sign * step * dy, x + sign * step * dx
                        if not (0 <= ny < h and 0 <= nx < w):
                            break
                        if opaque[ny, nx]:
                            sides.append((step, ny, nx))
                            break
                if len(sides) == 2 and sum(item[0] for item in sides) <= 12:
                    pairs.extend(sides)
            if not pairs:
                continue
            _, ny, nx = min(pairs, key=lambda item: (item[0] * 100 + int(np.square(result[item[1], item[2], :3].astype(np.int16) - rgb[y, x]).sum())))
            result[y, x, :3] = result[ny, nx, :3]
            alpha[y, x] = 255
            recolored[y, x] = True
            masks['filled-holes'][y, x] = True

        # Finish isolated pinholes that no longer have a readable source color.
        # Each round samples only an already opaque adjacent pixel. The closing
        # and five-neighbor rule keep this inside the recovered object instead
        # of growing its outer silhouette into genuine transparent gaps.
        iterative_fill = 0
        for _ in range(8):
            opaque = alpha == 255
            interior = _closed(opaque, 9) & ~opaque & around_restoration & near_petal
            padded = np.pad(opaque, 1)
            neighbors = sum(padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
                            for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy)
            holes = interior & (neighbors >= 5)
            if not holes.any():
                break
            for y, x in np.argwhere(holes):
                donors = []
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if (dy or dx) and 0 <= ny < h and 0 <= nx < w and opaque[ny, nx]:
                            distance = int(np.square(result[ny, nx, :3].astype(np.int16) - rgb[y, x]).sum())
                            donors.append((distance, ny, nx))
                if not donors:
                    continue
                _, ny, nx = min(donors)
                result[y, x, :3] = result[ny, nx, :3]
                alpha[y, x] = 255
                recolored[y, x] = True
                masks['filled-holes'][y, x] = True
                iterative_fill += 1
    else:
        iterative_fill = 0

    masks['recolored-seams'] = recolored
    assert np.array_equal(result[:, :, :3][~recolored], source[:, :, :3][~recolored])
    report = {'enabled': True, 'seedPixels': count, 'hiddenSeedFraction': round(hidden_seed_fraction, 4),
              'hiddenCoreFraction': round(hidden_core_fraction, 4),
              'visibleCoreFraction': round(visible_core_fraction, 4),
              'hiddenRecoveryEnabled': recover_hidden,
              'preservedVisible': int(preserved.sum()),
              'restoredHidden': int(masks['restored-hidden'].sum()),
              'filledHolePixels': int(masks['filled-holes'].sum()),
              'iterativeFillPixels': iterative_fill,
              'rgbUnchangedOutsideSeams': True,
              'recoloredSeamPixels': int(recolored.sum())}
    return result, masks, report

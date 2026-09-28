"""Healing Tool · Подорожник: recover stored RGB visibility, then remove baked grids.

CPU only. The opt-in light-safe profile may copy neighboring RGB into repaired
internal seams; the approved and robust profiles never recolor RGB.
"""
from pathlib import Path
import argparse
import hashlib
import json
import numpy as np
from PIL import Image
from final_cleaner_lab import clean_rgba, mask_file
from grid_structure import remove_grid_by_structure
from grid_structure_v2 import remove_grid_by_structure as remove_grid_robust, build_interior_detail_mask
from light_detail_guard import recover_light_details

NAME = 'Healing Tool · Подорожник'


def heal_rgba(rgba, *, keep=None, erase=None, profile='approved'):
    if profile not in ('approved','robust','light-safe'):raise ValueError('Unknown healing profile')
    auto_keep=np.zeros(rgba.shape[:2],bool);protection={'enabled':False}
    effective_keep=keep
    if profile in ('robust','light-safe'):
        auto_keep,protection=build_interior_detail_mask(rgba)
        protection['enabled']=True
        if erase is not None:auto_keep[erase.astype(bool)]=False
        protection['protectedVisible']=int(auto_keep.sum())
        effective_keep=auto_keep if keep is None else auto_keep|keep.astype(bool)
    restored, masks, recovery = clean_rgba(
        rgba, keep=effective_keep, erase=erase, refine_mask=True,
        small_neutral_gaps=True, repair_alpha_seams=True)
    remove=remove_grid_by_structure if profile=='approved' else remove_grid_robust
    result, removed, seeds, structure = remove(restored, keep=effective_keep)
    light_report={'enabled':False}
    if profile=='light-safe':
        result, light_masks, light_report = recover_light_details(rgba,result,structure)
        if erase is not None:
            forced=erase.astype(bool) if keep is None else erase.astype(bool)&~keep.astype(bool)
            result[:,:,3][forced]=0
            result[:,:,:3][forced]=rgba[:,:,:3][forced]
            for mask in light_masks.values():mask[forced]=False
        if keep is not None:
            result[keep.astype(bool)]=rgba[keep.astype(bool)]
            for mask in light_masks.values():mask[keep.astype(bool)]=False
        for name,mask in light_masks.items():masks['light-'+name]=mask
    masks['auto-protected']=auto_keep
    masks['structure-removed'] = removed & (restored[:, :, 3] > 0)
    masks['structure-seeds'] = seeds
    masks['final-restored'] = result[:, :, 3] > rgba[:, :, 3]
    masks['final-removed'] = result[:, :, 3] < rgba[:, :, 3]
    rgb_unchanged = bool(np.array_equal(result[:, :, :3], rgba[:, :, :3]))
    if profile != 'light-safe':
        assert rgb_unchanged
    return result, masks, {
        'toolName': NAME, 'profile':profile, 'executor': 'cpu', 'rgbUnchanged': rgb_unchanged,
        'automaticDetailProtection':protection,
        'recolorApplied': not rgb_unchanged, 'recovery': recovery, 'structure': structure,
        'lightDetailGuard':light_report}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--keep', type=Path)
    parser.add_argument('--erase', type=Path)
    parser.add_argument('--profile', choices=['approved','robust','light-safe'], default='approved',
                        help='approved: frozen rules; robust: geometry/detail guards; light-safe: candidate for light artwork on neutral grids')
    args = parser.parse_args()
    files = sorted(f for f in args.input.iterdir() if f.suffix.lower() == '.png') if args.input.is_dir() else [args.input]
    if not files:
        parser.error('No images found')
    if len(files) > 1 and (args.keep or args.erase):
        parser.error('Masks require a single input image')
    if args.output.exists():
        parser.error('Output exists; choose a new directory')
    args.output.mkdir(parents=True, exist_ok=False)
    reports = []
    for file in files:
        source_hash = hashlib.sha256(file.read_bytes()).hexdigest()
        with Image.open(file) as image:
            size = image.size
            rgba = np.array(image.convert('RGBA'))
        result, masks, report = heal_rgba(rgba, keep=mask_file(args.keep, size), erase=mask_file(args.erase, size),profile=args.profile)
        folder = args.output / file.name
        folder.mkdir()
        Image.fromarray(result).save(folder / 'result.png')
        for name, mask in masks.items():
            Image.fromarray(mask.astype('uint8') * 255).save(folder / (name + '.png'))
        assert source_hash == hashlib.sha256(file.read_bytes()).hexdigest()
        report.update(input=str(file.resolve()), sourceSha256=source_hash, sourceUnchanged=True,
                      scriptHashes={name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
                                    for name in ['healing_tool.py', 'final_cleaner_lab.py', 'grid_structure.py','grid_structure_v2.py','light_detail_guard.py']})
        (folder / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        reports.append(report)
        print(json.dumps({'file': file.name, 'rgbUnchanged': report['rgbUnchanged'], 'structureRemoved': report['structure'].get('removedVisible', 0)}, ensure_ascii=False), flush=True)
    (args.output / 'report.json').write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()

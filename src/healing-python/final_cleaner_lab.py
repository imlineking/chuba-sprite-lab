"""Checker cleanup and recovery from retained RGB. CPU, NumPy + Pillow only.

Usage: python final_cleaner_lab.py INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY
No source file is overwritten. RGB is preserved, including RGB under alpha=0.
"""
from pathlib import Path
import argparse
from collections import Counter
import hashlib
import json
import time
import numpy as np
from PIL import Image


def infer_palette(rgb):
    signed = rgb.astype(np.int16)
    neutral = np.ptp(signed, axis=2) <= 12
    value = signed.mean(axis=2)
    hist, _ = np.histogram(value[neutral], bins=np.arange(257))
    smooth = np.convolve(hist, np.ones(5), mode='same')
    first = int(np.argmax(smooth))
    allowed = np.abs(np.arange(256)-first) >= 20
    second = int(np.argmax(np.where(allowed, smooth, 0)))
    peaks = sorted([first, second])
    colors = []
    for peak in peaks:
        near = neutral & (np.abs(value-peak) <= 8)
        if near.sum() < 40:
            return None
        colors.append(np.median(rgb[near], axis=0))
    if np.max(np.abs(colors[0]-colors[1])) < 20:
        return None
    return np.array(colors), neutral


def fit_axis(signs):
    """Estimate fractional cell sizes after resizing, then fit grid phase."""
    rows = signs[::max(1, signs.shape[0]//48)].astype(float)
    sizes = Counter()
    for row in rows:
        changes = np.r_[0, np.flatnonzero(row[1:] != row[:-1])+1, len(row)]
        lengths, values = np.diff(changes), row[changes[:-1]]
        for n in range(1, len(lengths)-1):
            triple = lengths[n-1:n+2]
            if np.all(values[n-1:n+2] != 0) and triple.min() >= 2 and np.ptp(triple) <= 2:
                sizes[round(float(triple.mean()))] += 1
    if not sizes or sizes.most_common(1)[0][1] < 3:
        return None
    mode = sizes.most_common(1)[0][0]
    if mode > 128:
        return None
    nfft = len(rows[0])*16
    spectrum = np.abs(np.fft.rfft(rows, n=nfft, axis=1))**2
    power = spectrum.sum(axis=0)
    freq = np.fft.rfftfreq(nfft)
    valid = (freq >= 1/(2*(mode+2))) & (freq <= 1/(2*max(2,mode-2)))
    peak = int(np.argmax(np.where(valid,power,0)))
    if peak == 0 or power[peak] == 0:
        return None
    delta = 0.0
    if 0 < peak < len(power)-1:
        a,b,c = power[peak-1:peak+2]
        divisor = a-2*b+c
        if divisor:
            delta = float(np.clip(.5*(a-c)/divisor,-.5,.5))
    frequency = (peak+delta)/nfft
    coordinate = np.arange(rows.shape[1])
    # Phase modulo pi suffices: overall color order is fitted in two dimensions.
    phases = np.linspace(0,np.pi,96,endpoint=False)
    waves = np.where(np.cos(2*np.pi*frequency*coordinate[None,:]+phases[:,None])>=0,1,-1)
    correlations = rows@waves.T
    weights = np.maximum(1,np.count_nonzero(rows,axis=1))
    scores = np.mean((correlations/weights[:,None])**2,axis=0)
    best = int(np.argmax(scores))
    return {'cell':float(1/(2*frequency)), 'phase':float(phases[best]),
            'axisScore':float(scores[best]), 'runEvidence':int(sizes.most_common(1)[0][1]),
            'wave':waves[best]}


def components(mask, diagonal=False):
    """Run-length connected components; no OpenCV/SciPy required."""
    h,w = mask.shape
    labels = np.zeros((h,w),np.int32)
    parent = [0]
    def find(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n
    previous = []
    for y in range(h):
        changes = np.flatnonzero(np.diff(np.r_[False,mask[y],False].astype(np.int8)))
        current = []
        cursor = 0
        for start,end in zip(changes[::2],changes[1::2]):
            label = len(parent); parent.append(label)
            while cursor < len(previous) and previous[cursor][1] <= start-int(diagonal):
                cursor += 1
            n = cursor
            while n < len(previous) and previous[n][0] < end+int(diagonal):
                a,b = find(label),find(previous[n][2])
                if a != b:
                    parent[a] = b
                n += 1
            labels[y,start:end] = label
            current.append((int(start),int(end),label))
        previous = current
    lookup = np.array([find(n) for n in range(len(parent))],np.int32)
    return lookup[labels]


def local_runs(labels, component, bounds, axis):
    """Local alternation remains usable when an AI has warped the grid phase."""
    x0,y0,x1,y1=bounds
    region=np.where(component[y0:y1+1,x0:x1+1],labels[y0:y1+1,x0:x1+1],-1)
    if axis=='y':
        region=region.T
    coherent=0
    possible=0
    sizes=[]
    pairs=0
    possible_pairs=0
    pair_sizes=[]
    for row in region[::max(1,len(region)//32)]:
        changes=np.r_[0,np.flatnonzero(row[1:]!=row[:-1])+1,len(row)]
        lengths,values=np.diff(changes),row[changes[:-1]]
        for n in range(len(lengths)-1):
            pair=lengths[n:n+2]
            if np.all(values[n:n+2]>=0) and pair.min()>=2:
                possible_pairs+=1
                if np.ptp(pair)<=2:
                    pairs+=1
                    pair_sizes.append(float(pair.mean()))
        for n in range(1,len(lengths)-1):
            if np.all(values[n-1:n+2]>=0):
                triple=lengths[n-1:n+2]
                if triple.min()<2:
                    continue
                possible+=1
                if np.ptp(triple)<=2:
                    coherent+=1
                    sizes.append(float(np.mean(triple)))
    return {'support':coherent,'possible':possible,
            'fraction':coherent/max(1,possible),'cell':float(np.median(sizes)) if sizes else None,
            'pairs':pairs,'pairFraction':pairs/max(1,possible_pairs),
            'pairCell':float(np.median(pair_sizes)) if pair_sizes else None}


def shift(array, dy, dx, fill=0):
    result=np.full_like(array,fill)
    h,w=array.shape[:2]
    if abs(dy)>=h or abs(dx)>=w:
        return result
    y0,y1=max(0,-dy),min(h,h-dy);x0,x1=max(0,-dx),min(w,w-dx)
    result[y0:y1,x0:x1]=array[y0+dy:y1+dy,x0+dx:x1+dx]
    return result


def checker_lags(color_id, stable, component, bounds, cells):
    """Check checker parity across occlusions without demanding whole runs."""
    x0,y0,x1,y1=bounds
    labels=color_id[y0:y1+1,x0:x1+1]
    reliable=stable[y0:y1+1,x0:x1+1]&component[y0:y1+1,x0:x1+1]
    result={}
    for axis,cell in zip(('x','y'),cells):
        a=labels if axis=='x' else labels.T
        mask=reliable if axis=='x' else reliable.T
        best=None
        for offset in range(max(2,int(round(cell))-1),int(round(cell))+2):
            comparisons=[]
            for factor in (1,2):
                delta=offset*factor
                if delta>=a.shape[1]:
                    comparisons.append({'pairs':0,'agreement':0.0});continue
                pairs=mask[:,:-delta]&mask[:,delta:]
                match=(a[:,:-delta]!=a[:,delta:]) if factor==1 else (a[:,:-delta]==a[:,delta:])
                comparisons.append({'pairs':int(pairs.sum()),
                                    'agreement':float(match[pairs].mean()) if pairs.any() else 0.0})
            rank=comparisons[0]['agreement'] if comparisons[0]['pairs']>=24 else 0
            if best is None or rank>best['rank']:
                best={'offset':offset,'opposite':comparisons[0],
                      'repeat':comparisons[1],'rank':rank}
        result[axis]=best
    dx,dy=result['x']['offset'],result['y']['offset']
    diagonal=[]
    for signed_dx in (dx,-dx):
        shifted_labels=shift(labels,dy,signed_dx)
        pair=reliable&shift(reliable,dy,signed_dx)
        equal=labels==shifted_labels
        diagonal.append({'pairs':int(pair.sum()),'agreement':float(equal[pair].mean()) if pair.any() else 0.0})
    result['diagonal']=diagonal
    flips=all(result[axis]['opposite']['pairs']>=24 and result[axis]['opposite']['agreement']>=.82 for axis in ('x','y'))
    parity=any(d['pairs']>=24 and d['agreement']>=.82 for d in diagonal)
    repeat=all(result[axis]['repeat']['pairs']>=12 and result[axis]['repeat']['agreement']>=.75 for axis in ('x','y'))
    # Occluded two-by-two fragments can lack a second complete period. A
    # diagonal parity witness still distinguishes them from simple stripes.
    partial_flips=all(result[axis]['opposite']['pairs']>=48 and result[axis]['opposite']['agreement']>=.72 for axis in ('x','y'))
    partial_parity=any(d['pairs']>=24 and d['agreement']>=.8 for d in diagonal)
    # A warped grid loses exact phase after two cells. For larger regions,
    # require many witnesses in both axes, one surviving repeated period,
    # and diagonal parity, all at the independently detected cell size.
    many_flips=all(result[axis]['opposite']['pairs']>=96 and result[axis]['opposite']['agreement']>=.72 for axis in ('x','y'))
    one_repeat=any(result[axis]['repeat']['pairs']>=24 and result[axis]['repeat']['agreement']>=.7 for axis in ('x','y'))
    warped_parity=any(d['pairs']>=96 and d['agreement']>=.65 for d in diagonal)
    large=int(component[y0:y1+1,x0:x1+1].sum())>=6*cells[0]*cells[1]
    result['patterned']=bool((flips and (parity or repeat)) or
                              (partial_flips and partial_parity) or
                              (large and many_flips and one_repeat and warped_parity))
    return result


def refine_matte_mask(rgba, background, colors, width=1, inset=3):
    """Stage 2: remove only boundary pixels dominated by the known matte.

    This is not a blanket erosion: a black outline, a colored edge, or an
    edge agreeing with its own interior does not satisfy the mixture test.
    RGB is unchanged. Ambiguous/no-interior points are returned for review.
    """
    visible=rgba[:,:,3]>0
    layers=np.zeros(visible.shape,np.int16);inside=visible.copy()
    for depth in range(1,width+inset+3):
        layers[inside]=depth
        inside=np.logical_and.reduce([shift(inside,dy,dx) for dy in (-1,0,1) for dx in (-1,0,1)])
    nearby=background.copy()
    for _ in range(width):
        nearby=np.logical_or.reduce([shift(nearby,dy,dx) for dy in (-1,0,1) for dx in (-1,0,1)])
    selected=visible&(layers<=width)&nearby
    gy=shift(layers,1,0)-shift(layers,-1,0)
    gx=shift(layers,0,1)-shift(layers,0,-1)
    length=np.hypot(gx,gy)
    ys,xs=np.nonzero(selected&(length>0))
    nx=np.rint(xs+gx[ys,xs]/length[ys,xs]*inset).astype(int)
    ny=np.rint(ys+gy[ys,xs]/length[ys,xs]*inset).astype(int)
    valid=(nx>=0)&(nx<visible.shape[1])&(ny>=0)&(ny<visible.shape[0])
    nx=np.clip(nx,0,visible.shape[1]-1);ny=np.clip(ny,0,visible.shape[0]-1)
    previous=layers[ys,xs]
    for step in range(1,inset+1):
        px=np.rint(xs+(nx-xs)*step/inset).astype(int)
        py=np.rint(ys+(ny-ys)*step/inset).astype(int)
        at=layers[py,px]
        valid&=(at>=previous)&visible[py,px]
        previous=at
    valid&=layers[ny,nx]>layers[ys,xs]
    samples=rgba[ny,nx,:3].astype(float)
    edge=rgba[ys,xs,:3].astype(float)
    matched=np.zeros(len(xs),bool)
    for color in colors:
        direction=color-samples
        norm=(direction*direction).sum(axis=1)
        fraction=((edge-samples)*direction).sum(axis=1)/np.maximum(norm,1)
        fitted=samples+fraction[:,None]*direction
        residual=np.abs(fitted-edge).max(axis=1)
        # Require a strongly background-dominated mixture, not merely a
        # naturally lighter object pixel. Uncertain colors stay intact.
        matched|=(norm>=80**2)&(fraction>=.65)&(fraction<=1.15)&(residual<=12)
    erase=np.zeros(visible.shape,bool)
    erase[ys,xs]=valid&matched
    no_sample=selected.copy();no_sample[ys[valid],xs[valid]]=False
    return erase,no_sample


def isolated_matte_noise(rgba, colors):
    ids=components(rgba[:,:,3]>0,diagonal=True)
    counts=np.bincount(ids.ravel())
    rgb=rgba[:,:,:3].astype(np.int16)
    return (ids>0)&(counts[ids]<32)&(np.ptp(rgb,axis=2)<=50)&(rgb.mean(axis=2)>=colors.min()-80)


def repair_internal_alpha_seams(source, result):
    """Restore partial alpha between matching intact and recovered opaque RGB.

    This changes alpha only. Exterior antialiasing and unbracketed translucent
    details remain unchanged. Both donor paths must stay inside the cutout.
    """
    visible=result[:,:,3]>0
    restored=(source[:,:,3]==0)&(result[:,:,3]==255)
    interior=np.logical_and.reduce([shift(visible,dy,dx) for dy in (-1,0,1) for dx in (-1,0,1)])
    near=np.logical_or.reduce([shift(restored,dy,dx) for dy in range(-3,4) for dx in range(-3,4)])
    candidates=interior&near&(source[:,:,3]>0)&(source[:,:,3]<255)&(result[:,:,3]>0)
    ys,xs=np.nonzero(candidates);accepted=np.zeros(len(xs),bool)
    h,w=visible.shape;rgb=result[:,:,:3].astype(np.int16);color=rgb[ys,xs]
    def donor(dy,dx,steps):
        sy=ys+dy*steps;sx=xs+dx*steps
        valid=(sy>=0)&(sy<h)&(sx>=0)&(sx<w)
        sy=np.clip(sy,0,h-1);sx=np.clip(sx,0,w-1)
        for s in range(1,steps+1):
            py=np.clip(ys+dy*s,0,h-1);px=np.clip(xs+dx*s,0,w-1)
            valid&=visible[py,px]
        difference=np.max(np.abs(rgb[sy,sx]-color),axis=1)
        valid&=(result[sy,sx,3]>=240)&(difference<=45)
        return valid,restored[sy,sx],source[sy,sx,3]>=240
    for dy,dx in [(0,1),(1,0),(1,1),(1,-1)]:
        # Diagonal displacement stays within 5 px Euclidean distance.
        for steps in range(2,4 if dy and dx else 6):
            a,ar,ai=donor(dy,dx,steps);b,br,bi=donor(-dy,-dx,steps)
            accepted|=a&b&((ar&bi)|(br&ai))
    mask=np.zeros((h,w),bool);mask[ys[accepted],xs[accepted]]=True
    return mask


def clean_rgba(rgba, *, tolerance=14, restore='hidden', keep=None, erase=None, refine_mask=False, small_neutral_gaps=False, repair_alpha_seams=False):
    started = time.perf_counter()
    if rgba.ndim != 3 or rgba.shape[2] != 4 or rgba.dtype != np.uint8:
        raise ValueError('Expected uint8 RGBA')
    if not 0 <= tolerance <= 40 or restore not in ('hidden','all','preserve'):
        raise ValueError('Invalid tolerance or restoration policy')
    h,w = rgba.shape[:2]
    for mask in (keep,erase):
        if mask is not None and mask.shape != (h,w):
            raise ValueError('Mask dimensions must match the image')
    rgb = rgba[:,:,:3]
    result = rgba.copy()
    removed = np.zeros((h,w),bool)
    uncertain = np.zeros((h,w),bool)
    gaps=np.zeros((h,w),bool)
    report = {'operation':'checker-cleanup-and-alpha-recovery','width':w,'height':h,
              'restorePolicy':restore,'tolerance':tolerance,'grid':None,
              'warnings':[]}
    palette = infer_palette(rgb)
    if palette is not None:
        colors,neutral = palette
        differences = np.max(np.abs(rgb[:,:,None,:].astype(float)-colors[None,None,:,:]),axis=3)
        distance = differences.min(axis=2)
        color_id = differences.argmin(axis=2)
        # Resampling creates shades BETWEEN the two tile colors. They must not
        # be mistaken for hidden foreground and exposed as bright grid lines.
        value=rgb.astype(np.int16).mean(axis=2)
        candidate=(np.ptp(rgb.astype(np.int16),axis=2)<=24)&(value>=colors.min()-tolerance)&(value<=colors.max()+tolerance)
        signs = np.where(candidate,np.where(color_id==1,1,-1),0)
        fx,fy = fit_axis(signs),fit_axis(signs.T)
        if fx is not None and fy is not None:
            expected = fx['wave'][None,:]*fy['wave'][:,None]
            if np.sum(expected*signs)<0:
                expected = -expected
            matches = expected == signs
            agreement = float(matches[candidate].mean()) if candidate.any() else 0
            # A generated/resized pseudo-grid may drift across the image.
            # Validate repetition per connected region, not one global phase.
            if min(fx['runEvidence'],fy['runEvidence'])>=3:
                proposed_grid = {'colors':colors.round(2).tolist(),
                                  'x':{k:v for k,v in fx.items() if k!='wave'},
                                  'y':{k:v for k,v in fy.items() if k!='wave'},
                                  'rigidAgreement':agreement,'model':'local alternating runs and checker parity across occlusions'}
                ids = components(candidate)
                counts = np.bincount(ids.ravel())
                bright = np.bincount(ids.ravel(),weights=(color_id==1).ravel())
                coherent = np.bincount(ids.ravel(),weights=matches.ravel())
                # A component must contain both grid colors and repeat in both
                # directions. Isolated white/gray artwork is not proof of grid.
                minx = np.full(len(counts),w);maxx = np.zeros(len(counts),int)
                miny = np.full(len(counts),h);maxy = np.zeros(len(counts),int)
                ys,xs = np.nonzero(candidate);at=ids[ys,xs]
                np.minimum.at(minx,at,xs);np.maximum.at(maxx,at,xs)
                np.minimum.at(miny,at,ys);np.maximum.at(maxy,at,ys)
                balanced = np.minimum(bright,counts-bright) >= counts*.12
                patterned = np.zeros(len(counts),bool)
                component_reports=[]
                color_labels=np.where(candidate,color_id,-1)
                stable=np.abs(value-colors.mean())>abs(colors[1].mean()-colors[0].mean())*.15
                eligible=(counts>=40)&balanced
                eligible[0]=False
                for component_id in np.flatnonzero(eligible):
                    bounds=(minx[component_id],miny[component_id],maxx[component_id],maxy[component_id])
                    component=ids==component_id
                    x_evidence=local_runs(color_labels,component,bounds,'x')
                    y_evidence=local_runs(color_labels,component,bounds,'y')
                    valid=min(x_evidence['support'],y_evidence['support'])>=3 and min(x_evidence['fraction'],y_evidence['fraction'])>=.5
                    if valid:
                        valid=abs(x_evidence['cell']/fx['cell']-1)<=.2 and abs(y_evidence['cell']/fy['cell']-1)<=.2
                    if not valid and min(x_evidence['pairs'],y_evidence['pairs'])>=3 and min(x_evidence['pairFraction'],y_evidence['pairFraction'])>=.5:
                        valid=abs(x_evidence['pairCell']/fx['cell']-1)<=.2 and abs(y_evidence['pairCell']/fy['cell']-1)<=.2
                    clipped=False
                    lag=None
                    if not valid:
                        # Narrow holes truncate runs across the hole. The grid
                        # was independently established in both axes above.
                        # Require a long matching run sequence along the hole,
                        # plus either a narrow effective width or shorter,
                        # consistent evidence across it. Do not relax stripes
                        # into evidence for a new grid.
                        widths=(bounds[2]-bounds[0]+1,bounds[3]-bounds[1]+1)
                        for strong,weak,fit,other_fit,length in (
                            (x_evidence,y_evidence,fx,fy,widths[0]),
                            (y_evidence,x_evidence,fy,fx,widths[1])):
                            strong_ok=(strong['support']>=8 and strong['fraction']>=.45 and
                                       abs(strong['cell']/fit['cell']-1)<=.2)
                            narrow=counts[component_id]/length<=2.5*other_fit['cell']
                            weak_ok=(weak['support']>=8 and weak['fraction']>=.3 and
                                     abs(weak['cell']/other_fit['cell']-1)<=.2)
                            if strong_ok and (narrow or weak_ok):
                                clipped=True;valid=True;break
                    if not valid:
                        lag=checker_lags(color_id,stable,component,bounds,(fx['cell'],fy['cell']))
                        valid=lag['patterned']
                    patterned[component_id]=valid
                    component_reports.append({'area':int(counts[component_id]),'patterned':bool(valid),
                                              'clippedGrid':clipped,'bounds':[int(n) for n in bounds],
                                              'x':x_evidence,'y':y_evidence,'lag':lag})
                removed = candidate & patterned[ids]
                uncertain = candidate & ~removed
                if patterned.any():
                    report['grid']=proposed_grid
                    if small_neutral_gaps and colors.min()>=128:
                        # Explicit optional policy for small enclosed neutral
                        # gaps. A single surviving tile cannot demonstrate a
                        # period: do not claim that these pixels are confirmed
                        # checker. White artwork needs keep masks in this mode.
                        exact=np.bincount(ids.ravel(),weights=(distance<=tolerance).ravel())
                        neutral_support=np.bincount(ids.ravel(),weights=(np.ptp(rgb.astype(np.int16),axis=2)<=8).ravel())
                        small=(counts>=16)&(counts<=4*fx['cell']*fy['cell'])&~patterned
                        enclosed=(minx>0)&(miny>0)&(maxx<w-1)&(maxy<h-1)
                        short=(maxx-minx+1<=3.5*fx['cell'])&(maxy-miny+1<=3.5*fy['cell'])
                        supported=(exact>=counts*.8)|(neutral_support>=counts*.85)
                        gap_ids=small&enclosed&short&supported;gap_ids[0]=False
                        gaps=candidate&gap_ids[ids]
                        removed|=gaps;uncertain&=~gaps
                        report['smallNeutralGapPolicy']={'enabled':True,'selected':int(gaps.sum()),
                            'assumption':'Small enclosed neutral patches matching the detected light background are gaps; protect white artwork with keep masks.'}
                report['patternedComponents'] = int(patterned.sum())
                report['components']=component_reports
                report['checkerRemoved'] = int((removed&~gaps).sum())
            else:
                uncertain = candidate
                report['warnings'].append('No coherent two-axis grid; matching colors preserved.')
        else:
            uncertain = candidate
            report['warnings'].append('No repeated checker evidence; matching colors preserved.')
    if report['grid'] is None:
        # Unidentified images are kept exactly, rather than exposing background.
        report['warnings'].append('Alpha recovery requires an identified background or an explicit foreground mask.')
    else:
        # Hidden RGB which is still background-colored remains ambiguous.
        # Pure RGB zero under alpha=0 is absent evidence, not a recovered outline.
        foreground = ~removed & ~uncertain & np.any(rgb!=0,axis=2)
        # Hidden RGB also contains isolated compression/resampling specks.
        # Recover connected detail, not arbitrary non-background pixels. An
        # already visible small detail remains unchanged; this guard applies
        # only to newly revealed colors.
        detail_ids=components(foreground,diagonal=True)
        detail_sizes=np.bincount(detail_ids.ravel())
        supported=detail_sizes[detail_ids]>=8
        unsupported=foreground & ~supported & (rgba[:,:,3]==0)
        uncertain|=unsupported
        foreground&=supported
        report['unsupportedHiddenPixels']=int(unsupported.sum())
        eligible = (rgba[:,:,3]==0) if restore=='hidden' else (rgba[:,:,3]<255)
        if restore != 'preserve':
            result[:,:,3][foreground & eligible] = 255
    checker=removed&~gaps
    # Refinement must see the actual cutout, not a temporary image in which
    # accepted background pixels still have their original alpha.
    result[:,:,3][removed]=0
    matte=np.zeros((h,w),bool)
    noise=np.zeros((h,w),bool)
    alpha_seams=np.zeros((h,w),bool)
    if refine_mask and report['grid'] is not None:
        # A few disconnected background-like pixels are not contour detail.
        # Connected diagonal strokes are retained. keep masks override this.
        noise=isolated_matte_noise(result,colors)
        removed|=noise
        result[:,:,3][noise]=0
        report['isolatedMatteNoiseRemoved']=int(noise.sum())
        matte,no_sample=refine_matte_mask(result,removed,colors)
        removed|=matte
        result[:,:,3][matte]=0
        # Matte removal can disconnect a last speck from its former halo.
        noise|=isolated_matte_noise(result,colors)
        removed|=noise;result[:,:,3][noise]=0
        report['isolatedMatteNoiseRemoved']=int(noise.sum())
        report['noiseMaxComponentAreaExclusive']=32
        uncertain|=no_sample
        report['matteRefinement']={'width':1,'inset':3,'removed':int(matte.sum()),
                                   'noInteriorSample':int(no_sample.sum()),'rgbUnchanged':True}
    if repair_alpha_seams and report['grid'] is not None and restore!='preserve':
        alpha_seams=repair_internal_alpha_seams(rgba,result)
        result[:,:,3][alpha_seams]=255
    if erase is not None:
        removed |= erase.astype(bool)
    if keep is not None:
        protected = keep.astype(bool)
        removed[protected] = False
        checker[protected]=False;matte[protected]=False;noise[protected]=False;gaps[protected]=False
        alpha_seams[protected]=False
        result[protected] = rgba[protected]
    result[:,:,3][removed] = 0
    alpha_seams&=result[:,:,3]>rgba[:,:,3]
    raised = result[:,:,3]>rgba[:,:,3]
    lowered = result[:,:,3]<rgba[:,:,3]
    report.update({'restoredPixels':int(raised.sum()),'removedPreviouslyVisible':int(lowered.sum()),
                   'uncertainPixels':int(uncertain.sum()),'rgbUnchanged':True,
                   'retainedPartialAlphaPreserved':restore!='all' and not alpha_seams.any(),
                   'alphaSeamRepair':{'enabled':repair_alpha_seams,'repaired':int(alpha_seams.sum()),'rgbUnchanged':True,
                       'rule':'Interior partial-alpha pixels bracketed by matching intact and restored opaque RGB; continuous paths, donors 2..5 px away.'},
                   'uncertainVisiblePixels':int((uncertain&(result[:,:,3]>0)).sum()),
                   'elapsedMs':round((time.perf_counter()-started)*1000,2)})
    if 'smallNeutralGapPolicy' in report:
        report['smallNeutralGapPolicy']['selected']=int(gaps.sum())
    assert np.array_equal(result[:,:,:3],rgb)
    return result,{'restored':raised,'removed':lowered,'checker':checker,'uncertain':uncertain,'matte':matte,'noise':noise,'gaps':gaps,'alpha-seams':alpha_seams},report


def mask_file(file,size):
    if file is None:
        return None
    image=Image.open(file).convert('RGBA')
    if image.size != size:
        raise ValueError('Mask dimensions must match input')
    a=np.array(image)
    return (a[:,:,:3].max(axis=2)>=128)&(a[:,:,3]>=128)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',type=Path)
    parser.add_argument('output',type=Path)
    parser.add_argument('--tolerance',type=int,default=14)
    parser.add_argument('--restore-alpha',choices=['hidden','all','preserve'],default='hidden')
    parser.add_argument('--keep',type=Path)
    parser.add_argument('--erase',type=Path)
    parser.add_argument('--refine-mask',action='store_true',help='Stage 2: refine known background matte at the edge; RGB unchanged')
    parser.add_argument('--small-neutral-gaps',action='store_true',help='Optional: treat small enclosed light neutral patches matching the background as gaps; protect white artwork with --keep')
    parser.add_argument('--repair-alpha-seams',action='store_true',help='Stage 2: repair partial-alpha seams inside recovered objects; preserve RGB and exterior antialiasing')
    args=parser.parse_args()
    if not 0<=args.tolerance<=40:
        parser.error('Tolerance must be in 0..40')
    files=sorted(f for f in args.input.iterdir() if f.suffix.lower() in ('.png','.jpg','.jpeg','.webp')) if args.input.is_dir() else [args.input]
    if not files:
        parser.error('No images found')
    if len(files)>1 and (args.keep or args.erase):
        parser.error('Keep/erase masks require a single input image')
    if args.output.exists():
        parser.error('Output directory already exists; choose a new directory')
    args.output.mkdir(parents=True,exist_ok=False)
    entries=[]
    for file in files:
        before=hashlib.sha256(file.read_bytes()).hexdigest()
        with Image.open(file) as image:
            rgba=np.array(image.convert('RGBA'))
            size=image.size
        cleaned,masks,report=clean_rgba(rgba,tolerance=args.tolerance,restore=args.restore_alpha,
                                      keep=mask_file(args.keep,size),erase=mask_file(args.erase,size),refine_mask=args.refine_mask,small_neutral_gaps=args.small_neutral_gaps,repair_alpha_seams=args.repair_alpha_seams)
        folder=args.output/file.name
        folder.mkdir()
        Image.fromarray(cleaned).save(folder/'result.png')
        for name,mask in masks.items():
            Image.fromarray(mask.astype(np.uint8)*255).save(folder/(name+'.png'))
        assert before==hashlib.sha256(file.read_bytes()).hexdigest(),'Input changed'
        report.update({'input':str(file.resolve()),'sourceSha256':before,'sourceUnchanged':True,
                       'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        (folder/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        entries.append(report)
        print(json.dumps({'file':file.name,'grid':report['grid'],'restored':report['restoredPixels'],
                          'removed':report['removedPreviouslyVisible'],'uncertain':report['uncertainPixels']},ensure_ascii=False))
    (args.output/'report.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':
    main()

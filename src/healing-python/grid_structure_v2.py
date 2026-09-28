"""Candidate v2: small-grid period correction and local interior-detail guards.

No neutral-color filter, light/dark palette, or named foreground color is used
to find the grid. Grid RGB is learned AFTER geometric confirmation, to stop at
the foreground. Works on hidden RGB as well as visible RGB.
"""
import time
import numpy as np
from final_cleaner_lab import components


def square_nodes(rgb):
    a=rgb.astype(np.int16)
    gx=np.max(np.abs(a[:,1:]-a[:,:-1]),axis=2)
    gy=np.max(np.abs(a[1:]-a[:-1]),axis=2)
    # Interior of a flat cell. Threshold describes local variation, not color.
    edge=np.zeros(a.shape[:2],bool)
    edge[:,1:]|=gx>6
    edge[1:]|=gy>6
    flat=~edge
    ids=components(flat);counts=np.bincount(ids.ravel());h,w=flat.shape
    ys,xs=np.nonzero(flat);at=ids[ys,xs]
    minx=np.full(len(counts),w);maxx=np.zeros(len(counts),int)
    miny=np.full(len(counts),h);maxy=np.zeros(len(counts),int)
    np.minimum.at(minx,at,xs);np.maximum.at(maxx,at,xs)
    np.minimum.at(miny,at,ys);np.maximum.at(maxy,at,ys)
    widths=maxx-minx+1;heights=maxy-miny+1
    valid=(counts>=1)&(widths>=1)&(heights>=1)&(widths<=128)&(heights<=128)&(counts>=widths*heights*.7)&(widths/heights>.65)&(widths/heights<1.55)
    valid[0]=False;nodes=[]
    for n in np.flatnonzero(valid):
        x0,x1=int(minx[n]),int(maxx[n]+1);y0,y1=int(miny[n]),int(maxy[n]+1)
        m=ids[y0:y1,x0:x1]==n
        color=np.median(a[y0:y1,x0:x1][m],axis=0)
        nodes.append({'x':(x0+x1-1)/2,'y':(y0+y1-1)/2,'w':x1-x0+1,'h':y1-y0+1,'rgb':color,'bounds':(x0,y0,x1,y1),'id':int(n),'area':int(counts[n])})
    return nodes,ids


def detect_structure(rgb):
    nodes,ids=square_nodes(rgb)
    if len(nodes)<8:return [],ids,{'found':False,'squareCandidates':len(nodes)}
    # Repeated square dimensions, weighted by area so tiny artwork texels do not
    # dominate a larger background grid.
    hist=np.zeros(129)
    for n in nodes:
        size=int(round((n['w']+n['h'])/2));hist[min(128,max(2,size))]+=n['area']
    cell=int(np.argmax(hist));pool=[n for n in nodes if abs(n['w']/cell-1)<=.3 and abs(n['h']/cell-1)<=.3]
    # Blurring shrinks the flat interior. Recover FULL cell dimensions from
    # repeated centre spacing, rather than confusing interior width with period.
    spacing=np.zeros(129)
    initial_bins={}
    for i,n in enumerate(pool):initial_bins.setdefault((int(n['x']//cell),int(n['y']//cell)),[]).append(i)
    for n in pool:
        bx=int(n['x']//cell);by=int(n['y']//cell);near=[]
        for ox in range(-2,3):
            for oy in range(-2,3):near.extend(pool[j] for j in initial_bins.get((bx+ox,by+oy),[]))
        for axis,other in [('x','y'),('y','x')]:
            gaps=[q[axis]-n[axis] for q in near if cell*.7<=q[axis]-n[axis]<=cell*2.5 and abs(q[other]-n[other])<=max(1,cell*.2)]
            if gaps:
                s=int(round(min(gaps)))
                if s<=128:spacing[s]+=n['area']
    if spacing.max()>0:cell=int(np.argmax(spacing))
    bins={}
    for i,n in enumerate(pool):bins.setdefault((int(n['x']//cell),int(n['y']//cell)),[]).append(i)
    def neighbour(n,dx,dy):
        tx=n['x']+dx*cell;ty=n['y']+dy*cell;bx=int(tx//cell);by=int(ty//cell);best=None
        for ox in (-1,0,1):
            for oy in (-1,0,1):
                for j in bins.get((bx+ox,by+oy),[]):
                    q=pool[j];d=np.hypot(q['x']-tx,q['y']-ty)
                    if d<=max(2.5,cell*.3) and (best is None or d<best[0]):best=(d,j)
        return None if best is None else best[1]
    accepted=set();quads=0;parent=list(range(len(pool)))
    def find(n):
        while parent[n]!=n:parent[n]=parent[parent[n]];n=parent[n]
        return n
    def join(a,b):
        a=find(a);b=find(b)
        if a!=b:parent[b]=a
    for i,n in enumerate(pool):
        for dx,dy in [(1,1),(1,-1),(-1,1),(-1,-1)]:
            j=neighbour(n,dx,0);k=neighbour(n,0,dy);q=neighbour(n,dx,dy)
            if j is None or k is None or q is None:continue
            a=n['rgb'];b=pool[j]['rgb'];c=pool[k]['rgb'];d=pool[q]['rgb']
            contrast=min(np.max(np.abs(a-b)),np.max(np.abs(a-c)))
            if contrast<10:continue
            if max(np.max(np.abs(a-d)),np.max(np.abs(b-c)))>max(6,contrast*.4):continue
            accepted.update((i,j,k,q));quads+=1
            join(i,j);join(i,k);join(i,q)
    quad_nodes=accepted.copy();groups={}
    for i in accepted:groups.setdefault(find(i),[]).append(i)
    accepted=set()
    for group in groups.values():
        if len(group)<16:continue
        xs=[pool[i]['x'] for i in group];ys=[pool[i]['y'] for i in group]
        if max(xs)-min(xs)>=cell*2 and max(ys)-min(ys)>=cell*2:accepted.update(group)
    repeated=len(accepted)
    # Once repetition is established, locally clipped patches of that SAME
    # square size do not need sixteen intact cells of their own.
    if repeated>=16:accepted=quad_nodes
    result=[]
    for i in sorted(accepted):
        n=pool[i].copy();opposites=[pool[j] for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)] if (j:=neighbour(n,dx,dy)) in accepted]
        if not opposites:continue
        n['other']=np.median([q['rgb'] for q in opposites],axis=0)
        n['cellx']=np.median([abs(q['x']-n['x']) for q in opposites if abs(q['x']-n['x'])>cell*.5]) if any(abs(q['x']-n['x'])>cell*.5 for q in opposites) else cell
        n['celly']=np.median([abs(q['y']-n['y']) for q in opposites if abs(q['y']-n['y'])>cell*.5]) if any(abs(q['y']-n['y'])>cell*.5 for q in opposites) else cell
        result.append(n)
    return result,ids,{'found':len(result)>=8,'cell':cell,'squareCandidates':len(nodes),'confirmedSquares':len(result),'repeatedRegionSquares':repeated,'alternatingQuads':quads}


def interior_detail_guard(rgba, nodes, modes, boundary_matches):
    """Keep enclosed patches that contradict nearby established checker phases.

    This does not identify white/black by name. Evidence is the position of the
    learned tones in local alternating cells. A single matching partial cell
    remains removable. Details connected to background still need explicit keep.
    """
    h,w=boundary_matches.shape;protected=np.zeros((h,w),bool)
    ids=components(boundary_matches);counts=np.bincount(ids.ravel())
    ys,xs=np.nonzero(boundary_matches);at=ids[ys,xs]
    minx=np.full(len(counts),w);maxx=np.zeros(len(counts),int)
    miny=np.full(len(counts),h);maxy=np.zeros(len(counts),int)
    np.minimum.at(minx,at,xs);np.maximum.at(maxx,at,xs)
    np.minimum.at(miny,at,ys);np.maximum.at(maxy,at,ys)
    cell=float(np.median([n['cellx'] for n in nodes]));details=[]
    flat_w=float(np.median([n['w'] for n in nodes]));flat_h=float(np.median([n['h'] for n in nodes]))
    anchors_pool=[n for n in nodes if abs(n['w']/flat_w-1)<=.1 and abs(n['h']/flat_h-1)<=.1
                  and min(np.max(np.abs(n['rgb']-v)) for v in modes)<=20]
    if len(anchors_pool)<4:return protected,details
    centres=np.array([[n['x'],n['y']] for n in anchors_pool])
    for label in np.flatnonzero((counts>=8)&(counts<=256*cell*cell)):
        if label==0:continue
        x0,x1=int(minx[label]),int(maxx[label]+1);y0,y1=int(miny[label]),int(maxy[label]+1)
        if x0==0 or y0==0 or x1==w or y1==h:continue
        # At least one full cell span is needed to test repetition in a patch.
        if max(x1-x0,y1-y0)<cell*1.25:continue
        patch=ids[y0:y1,x0:x1]==label
        # A remnant connected through already removed grid RGB is not an intact
        # artwork patch. Protect only a fully visible enclosed detail here.
        if not np.all(rgba[y0:y1,x0:x1,3][patch]>=240):continue
        yy,xx=np.nonzero(patch);xx=xx+x0;yy=yy+y0
        rgb=rgba[yy,xx,:3].astype(np.int16)
        closest=np.argmin([np.max(np.abs(rgb-v),axis=1) for v in modes],axis=0)
        # A locally shifted board still contains alternating tones. This guard
        # concerns a coherent artwork tone, never an independently tiled patch.
        if np.bincount(closest,minlength=2).max()<len(closest)*.95:continue
        centre=np.array([(x0+x1-1)/2,(y0+y1-1)/2])
        distance=np.linalg.norm(centres-centre,axis=1)
        anchors=np.argsort(distance)[:8];scores=[];phases=[]
        for anchor in anchors:
            n=anchors_pool[anchor];cx,cy=cell,cell
            if distance[anchor]>cell*8+max(x1-x0,y1-y0)/2:continue
            local_x=np.floor((xx-(n['x']-cx/2))/cx).astype(int)
            local_y=np.floor((yy-(n['y']-cy/2))/cy).astype(int)
            tone=int(np.argmin([np.max(np.abs(n['rgb']-v)) for v in modes]))
            phase=(local_x+local_y+tone)%2
            expected=np.array(modes)[phase];phases.append(phase)
            # Relative fit must favour the expected tone, not merely lie in
            # overlapping tolerance balls of two low-contrast background tones.
            err=np.max(np.abs(rgb-expected),axis=1)
            other=np.max(np.abs(rgb-np.array(modes)[1-(local_x+local_y+tone)%2]),axis=1)
            scores.append(float((err<=other).mean()))
        # A locally changing phase/scale cannot justify automatic protection.
        # All nearby intact anchors must agree on the predicted grid here.
        coherent=len(phases)>=4 and all(float((p==phases[0]).mean())>=.98 for p in phases[1:])
        if coherent and max(scores)<.75:
            protected[yy,xx]=True
            details.append({'bounds':[x0,y0,x1,y1],'area':int(counts[label]),'bestLocalPhaseFit':round(max(scores),4)})
    return protected,details


def learned_values(nodes):
    values=np.array([n['rgb'] for n in nodes])
    bins,labels,counts=np.unique((values//8).astype(int),axis=0,return_inverse=True,return_counts=True)
    modes=[]
    for label in np.argsort(counts)[::-1]:
        value=np.median(values[labels==label],axis=0)
        if not modes or min(np.max(np.abs(value-v)) for v in modes)>=10:modes.append(value)
        if len(modes)==2:break
    return modes


def build_interior_detail_mask(rgba, *, tolerance=28):
    if rgba.ndim!=3 or rgba.shape[2]!=4 or rgba.dtype!=np.uint8:raise ValueError('Expected uint8 RGBA')
    rgb=rgba[:,:,:3];empty=np.zeros(rgb.shape[:2],bool)
    nodes,ids,report=detect_structure(rgb)
    if not report['found']:return empty,{'found':False,'protectedVisible':0,'regions':[]}
    modes=learned_values(nodes)
    if len(modes)<2:return empty,{'found':False,'protectedVisible':0,'regions':[]}
    matches=np.min([np.max(np.abs(rgb.astype(np.int16)-v),axis=2) for v in modes],axis=0)<=tolerance
    protected,regions=interior_detail_guard(rgba,nodes,modes,matches)
    return protected,{'found':True,'protectedVisible':int(protected.sum()),'regions':regions}


def remove_grid_by_structure(rgba, *, keep=None, tolerance=28, protect_interior_details=True):
    started=time.perf_counter()
    if rgba.ndim!=3 or rgba.shape[2]!=4 or rgba.dtype!=np.uint8:raise ValueError('Expected uint8 RGBA')
    rgb=rgba[:,:,:3];h,w=rgb.shape[:2]
    if keep is not None and keep.shape!=(h,w):raise ValueError('Keep mask must match the image')
    nodes,ids,report=detect_structure(rgb)
    erase=np.zeros((h,w),bool);seed=np.zeros((h,w),bool)
    if not report['found']:return rgba.copy(),erase,seed,report
    # Local background colors are learned from confirmed squares. Propagate the
    # field into occluded/partial cells; stop where RGB leaves this learned field.
    accepted_ids=np.array([n['id'] for n in nodes]);seed=np.isin(ids,accepted_ids)
    # These values come ONLY from the confirmed square pattern. No palette was
    # provided to the detector. Dominant values reject stray artwork squares.
    modes=learned_values(nodes)
    if len(modes)<2:
        report['found']=False;report['reason']='No two distinct values in confirmed square pattern'
        return rgba.copy(),erase,seed,report
    distance=np.min([np.max(np.abs(rgb.astype(np.int16)-v),axis=2) for v in modes],axis=0)
    boundary_matches=distance<=tolerance
    for n in nodes:
        if min(np.max(np.abs(n['rgb']-v)) for v in modes)>20:continue
        cx,cy=n['cellx'],n['celly'];radius=8
        x0=max(0,int(n['x']-radius*cx));x1=min(w,int(n['x']+radius*cx+1))
        y0=max(0,int(n['y']-radius*cy));y1=min(h,int(n['y']+radius*cy+1))
        # Once the AREA is a grid, clipped cells need not prove parity again.
        # The learned field reaches through occlusion; foreground stops it.
        erase[y0:y1,x0:x1]|=boundary_matches[y0:y1,x0:x1]
    protected=np.zeros((h,w),bool);details=[]
    if protect_interior_details:
        protected,details=interior_detail_guard(rgba,nodes,modes,boundary_matches)
        erase[protected]=False
    if keep is not None:erase[keep.astype(bool)]=False
    result=rgba.copy();result[:,:,3][erase]=0
    report.update({'removedVisible':int((erase&(rgba[:,:,3]>0)).sum()),'rgbUnchanged':True,'executor':'cpu','toleranceAtObjectBoundary':tolerance,
        'learnedBoundaryValues':[v.tolist() for v in modes],'maxPropagationCells':8,
        'interiorDetailProtection':{'enabled':protect_interior_details,'protectedVisible':int((protected&(rgba[:,:,3]>0)).sum()),'regions':details},
        'elapsedMs':round((time.perf_counter()-started)*1000,2),
        'rule':'Alternating square geometry; local grid field extended into partial cells; RGB boundary comparison after structure detection.'})
    return result,erase,seed,report

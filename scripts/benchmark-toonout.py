"""Separate, local-only matting trial. No integration with the copilot or EXE.
Usage: python benchmark-toonout.py <official-repo> <official-weights> <cases.json> <out>
Requires torch (CPU is enough), torchvision, timm, kornia, einops, huggingface_hub,
opencv-python, scipy, scikit-image, wandb. Uses weights_only=True and strict loading.
"""
import os
os.environ['WANDB_MODE'] = 'disabled'
os.environ['HF_HUB_OFFLINE'] = '1'
import sys
import json
import time
import hashlib
from pathlib import Path
import torch
import numpy as np
from PIL import Image
from torchvision import transforms
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from birefnet.models.birefnet import BiRefNet

weights = Path(sys.argv[2])
cases = json.loads(Path(sys.argv[3]).read_text(encoding='utf-8'))
out = Path(sys.argv[4]); out.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(6)
model = BiRefNet(bb_pretrained=False)
checkpoint = torch.load(weights, map_location='cpu', weights_only=True)
state = checkpoint.get('state_dict', checkpoint)
state = {key.removeprefix('module.').removeprefix('_orig_mod.'): value for key, value in state.items()}
model.load_state_dict(state, strict=True)
model.eval()
transform = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(), transforms.Normalize([.485,.456,.406],[.229,.224,.225])])
report = {'model':'ToonOut', 'weightsSha256':hashlib.sha256(weights.read_bytes()).hexdigest(), 'weightsBytes':weights.stat().st_size, 'device':'cpu', 'inputSize':1024, 'cases':[]}
for entry in cases:
    source = Image.open(entry['path']).convert('RGBA')
    source_alpha = np.asarray(source)[:,:,3]
    # Existing holes remain holes; hidden RGB underneath transparency is not a new object.
    image = Image.alpha_composite(Image.new('RGBA', source.size, (255,255,255,255)), source).convert('RGB')
    started = time.perf_counter()
    with torch.inference_mode():
        alpha = model(transform(image).unsqueeze(0))[-1].sigmoid().squeeze().cpu().numpy()
    mask = Image.fromarray((alpha * 255).clip(0,255).astype('uint8')).resize(image.size, Image.Resampling.BILINEAR)
    mask = Image.fromarray(np.minimum(np.asarray(mask), source_alpha).astype('uint8'))
    output = source.copy(); output.putalpha(mask); output.save(out / (entry['id']+'.png'))
    values = np.asarray(mask); rgb = np.asarray(image)
    saturated = (rgb.max(axis=2).astype('int16') - rgb.min(axis=2).astype('int16') > 40) & (source_alpha > 127)
    metrics = {'id':entry['id'], 'elapsedMs':round((time.perf_counter()-started)*1000), 'opaqueShare':round(float((values>127).mean()),4), 'colouredPixelsRemoved':int(((values<16)&saturated).sum()), 'colouredPixels':int(saturated.sum()), 'output':str(out / (entry['id']+'.png'))}
    if entry.get('reference'):
        reference = np.asarray(Image.open(entry['reference']).convert('RGBA'))[:,:,3] > 127
        predicted = values > 127
        intersection = (predicted & reference).sum(); union = (predicted | reference).sum()
        metrics.update({'IoU':round(float(intersection/max(1,union)),4), 'foregroundLost':int((reference & ~predicted).sum()), 'backgroundRemaining':int((~reference & predicted).sum())})
    report['cases'].append(metrics)
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(metrics),flush=True)

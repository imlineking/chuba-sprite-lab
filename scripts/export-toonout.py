"""Export reviewed local ToonOut weights, with no runtime downloads."""
import os
os.environ['WANDB_MODE'] = 'disabled'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['WANDB_DIR'] = os.getcwd()
import sys, json, hashlib, time
from pathlib import Path
import torch
import onnx
from torch.onnx.symbolic_helper import parse_args

@parse_args('v','v','v','v','v','i','i','i','i','i','i','i','i','b')
def deform_conv(g, image, weight, offset, mask, bias, sh, sw, ph, pw, dh, dw, groups, offset_groups, use_mask):
    args = [image, weight, offset, bias]
    if use_mask:
        args.append(mask)
    return g.op('DeformConv', *args, strides_i=[sh,sw], pads_i=[ph,pw,ph,pw], dilations_i=[dh,dw], group_i=groups, offset_group_i=offset_groups)

torch.onnx.register_custom_op_symbolic('torchvision::deform_conv2d', deform_conv, 19)

repo, weights, output = map(Path, sys.argv[1:4])
assert hashlib.sha256(weights.read_bytes()).hexdigest() == '8c7f8a0bc24400f4caade76622f75ff22ca1e93e169add9d2b70093e2487fbe5'
sys.path.insert(0, str(repo.resolve()))
from birefnet.models.birefnet import BiRefNet
torch.set_num_threads(4)
network = BiRefNet(bb_pretrained=False)
checkpoint = torch.load(weights, map_location='cpu', weights_only=True)
state = checkpoint.get('state_dict', checkpoint)
network.load_state_dict({k.removeprefix('module.').removeprefix('_orig_mod.'): v for k,v in state.items()}, strict=True)
network.eval()

class Alpha(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, image):
        return self.model(image)[-1].sigmoid()

output.parent.mkdir(parents=True, exist_ok=True)
started = time.perf_counter()
print('Exporting fixed 1024x1024 sigmoid alpha', flush=True)
torch.onnx.export(Alpha(network).eval(), torch.zeros(1,3,1024,1024), str(output), input_names=['input'], output_names=['alpha'], opset_version=19, dynamo=False, do_constant_folding=True)
onnx.checker.check_model(str(output))
digest = hashlib.sha256(output.read_bytes()).hexdigest()
report = {'file':output.name, 'sizeBytes':output.stat().st_size, 'sha256':digest, 'sourceWeightsSha256':hashlib.sha256(weights.read_bytes()).hexdigest(), 'opset':19, 'inputSize':1024, 'output':'sigmoid-alpha', 'elapsedSeconds':round(time.perf_counter()-started,2)}
output.with_suffix('.export.json').write_text(json.dumps(report,indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)

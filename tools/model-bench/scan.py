import csv
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from huggingface_hub import hf_hub_download
from PIL import Image
from transformers import AutoImageProcessor, SiglipForImageClassification


torch.set_num_threads(2)
owen_path = hf_hub_download(
    "OwenElliott/image-safety-classifier-s", "onnx/image-safety-classifier-s.onnx"
)
owen = ort.InferenceSession(owen_path, providers=["CPUExecutionProvider"])
siglip_name = "prithivMLmods/siglip2-mini-explicit-content"
processor = AutoImageProcessor.from_pretrained(siglip_name)
siglip = SiglipForImageClassification.from_pretrained(siglip_name).eval()
labels = {int(index): name for index, name in siglip.config.id2label.items()}
assert set(labels) == set(range(5)), labels

paths = sorted(Path(sys.argv[1]).glob("*.jpg"), key=lambda p: int(p.stem))
paths += [Path(name) for name in sys.argv[2:]]
assert paths and all(path.is_file() for path in paths), "no images found"

writer = csv.writer(sys.stdout)
writer.writerow(("file", "owen_nsfw", "owen_nsfl", "owen_sfw", *[f"siglip_{labels[i]}" for i in range(5)]))
for path in paths:
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        pixels = np.asarray(rgb.resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)
        pixels = pixels.transpose(2, 0, 1)[None]
        owen_scores = owen.run(None, {owen.get_inputs()[0].name: pixels})[0][0]
        inputs = processor(images=rgb, return_tensors="pt")
    with torch.inference_mode():
        siglip_scores = siglip(**inputs).logits.softmax(dim=-1)[0].tolist()
    writer.writerow((path.name, f"{owen_scores[1]:.6f}", f"{owen_scores[0]:.6f}", f"{owen_scores[2]:.6f}", *[f"{score:.6f}" for score in siglip_scores]))
    sys.stdout.flush()

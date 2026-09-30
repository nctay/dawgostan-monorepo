import csv
import sys
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForImageClassification


model_name = "Falconsai/nsfw_image_detection"
torch.set_num_threads(2)
processor = AutoImageProcessor.from_pretrained(model_name)
model = AutoModelForImageClassification.from_pretrained(model_name).eval()
labels = {label.lower(): index for index, label in model.config.id2label.items()}
assert "nsfw" in labels and "normal" in labels, labels

paths = sorted(Path(sys.argv[1]).glob("*.jpg"), key=lambda path: int(path.stem))
assert paths, "no numbered JPG files found"
writer = csv.writer(sys.stdout)
writer.writerow(("file", "nsfw", "normal"))
with torch.inference_mode():
    for path in paths:
        with Image.open(path) as image:
            inputs = processor(images=image.convert("RGB"), return_tensors="pt")
        scores = model(**inputs).logits.softmax(dim=-1)[0]
        writer.writerow((path.name, f"{scores[labels['nsfw']].item():.6f}", f"{scores[labels['normal']].item():.6f}"))
        sys.stdout.flush()

import io
import json
import logging
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image, UnidentifiedImageError
from transformers import AutoImageProcessor, SiglipForImageClassification


torch.set_num_threads(2)
owen = ort.InferenceSession('/app/owen/onnx/image-safety-classifier-s.onnx', providers=['CPUExecutionProvider'])
processor = AutoImageProcessor.from_pretrained('/app/siglip', use_fast=False)
siglip = SiglipForImageClassification.from_pretrained('/app/siglip').eval()
explicit_indices = [int(index) for index, label in siglip.config.id2label.items()
                    if label in {'Extincing & Sensual', 'Hentai', 'Pornography'}]
assert len(explicit_indices) == 3, siglip.config.id2label


def classify(data):
    with Image.open(io.BytesIO(data)) as opened:
        if opened.width * opened.height > 40_000_000:
            raise ValueError('image dimensions exceed limit')
        image = opened.convert('RGB')
    pixels = np.asarray(image.resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)
    pixels = pixels.transpose(2, 0, 1)[None]
    owen_score = float(owen.run(None, {owen.get_inputs()[0].name: pixels})[0][0][1])
    with torch.inference_mode():
        inputs = processor(images=image, return_tensors='pt')
        probabilities = siglip(**inputs).logits.softmax(dim=-1)[0]
        siglip_score = sum(probabilities[index].item() for index in explicit_indices)
    return {'owen': owen_score, 'siglip': siglip_score}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()

    def do_POST(self):
        if self.path != '/classify':
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32 * 1024 * 1024:
                raise ValueError('invalid image size')
            result = classify(self.rfile.read(size))
        except (ValueError, UnidentifiedImageError) as error:
            self.send_error(400, str(error))
            return
        except Exception as error:
            print(json.dumps({
                'alert_code': 'nsfw_classification_failed',
                'alert_title': 'Ошибка NSFW-классификатора',
                'alert_reason': 'Не хватило памяти при анализе изображения' if isinstance(error, MemoryError) else 'Не удалось проверить изображение',
                'alert_severity': 'warning',
                'alert_component': 'nsfw',
                'error_code': 'memory' if isinstance(error, MemoryError) else 'classification',
                'error_message': f'{type(error).__name__}: {error}',
            }, ensure_ascii=False), file=sys.stderr, flush=True)
            logging.exception('classification failed')
            self.send_error(500)
            return
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3333), Handler).serve_forever()

FROM falconsai-nsfw-local:2026-09-28

RUN pip install --no-cache-dir onnxruntime==1.23.2

COPY scan.py /app/scan.py
CMD ["python", "/app/scan.py", "/media"]

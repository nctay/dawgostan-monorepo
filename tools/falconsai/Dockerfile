FROM python:3.11-slim

RUN pip install --no-cache-dir torch==2.8.0 transformers==4.56.2 pillow==11.3.0

COPY scan.py /app/scan.py
CMD ["python", "/app/scan.py", "/media"]

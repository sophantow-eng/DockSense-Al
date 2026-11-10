# Cloud (Render ฟรี): Tesseract + OpenCV เท่านั้น ไม่มี torch → เบา
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-tha libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV PORT=7860 PYTHONUNBUFFERED=1
# Render ส่ง PORT มาให้เอง · ไม่ฝังรหัสใด ๆ ในภาพ (ตั้งผ่าน environment ของโฮสต์)
CMD ["sh","-c","uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

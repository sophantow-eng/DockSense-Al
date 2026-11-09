FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt
COPY app ./app
# ดาวน์โหลดโมเดล EasyOCR ล่วงหน้า (ไม่ต้องรอตอนรถคันแรก)
RUN python -c "import easyocr; easyocr.Reader(['th','en'], gpu=False)"
ENV PORT=7860
CMD ["sh","-c","uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

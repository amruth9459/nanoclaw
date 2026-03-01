# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    poppler-utils \
    imagemagick \
    tesseract-ocr \
    tesseract-ocr-all \
    ffmpeg \
    python3-pip \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install Python libraries: PDF generation + DWG/DXF parsing + rendering
RUN pip3 install --break-system-packages weasyprint ezdxf matplotlib

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Install OCR helper script
COPY skills/ocr.sh /usr/local/bin/ocr
RUN chmod +x /usr/local/bin/ocr

# Install video frame extraction script
COPY skills/extract-frame.sh /usr/local/bin/extract-frame
RUN chmod +x /usr/local/bin/extract-frame

# Install PDF generation script
COPY skills/generate-pdf.sh /usr/local/bin/generate-pdf
RUN chmod +x /usr/local/bin/generate-pdf

# Install Lexios document preparation (PDF → PNG for construction doc analysis)
COPY skills/lexios-prep.sh /usr/local/bin/lexios-prep
RUN chmod +x /usr/local/bin/lexios-prep

# Install Lexios DXF/DWG extraction (structured data + layer rendering)
COPY skills/lexios-dxf.py /usr/local/bin/lexios-dxf
RUN chmod +x /usr/local/bin/lexios-dxf

# Install Lexios query classifier (fast keyword-based routing)
COPY skills/lexios/query-classifier.py /usr/local/bin/lexios-classify
RUN chmod +x /usr/local/bin/lexios-classify

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Uses pre-compiled /app/dist (built during docker build) — no runtime tsc.
# To update agent code, rebuild the image with ./container/build.sh or ./deploy.sh.
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

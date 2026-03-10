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

# Install Python libraries (base + any integration deps from skills/*/requirements.txt)
COPY requirements.txt /tmp/requirements.txt
COPY skills/ /tmp/skills-scan/
RUN find /tmp/skills-scan -name requirements.txt -exec cat {} + >> /tmp/requirements.txt 2>/dev/null; \
    pip3 install --break-system-packages -r /tmp/requirements.txt && \
    rm -rf /tmp/requirements.txt /tmp/skills-scan

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PATH="/usr/local/bin/integration-scripts:${PATH}"

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

# Install GWS helper script
RUN mkdir -p /workspace/gws
COPY skills/gws/gws_helper.py /workspace/gws/gws_helper.py
RUN chmod +x /workspace/gws/gws_helper.py

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

FROM python:3.11-slim

# Install Node.js 20 via NodeSource
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node deps (cached layer)
COPY package.json ./
RUN npm install --production --no-fund --no-audit

# Copy source
COPY . .

EXPOSE 3000

CMD ["bash", "start.sh"]

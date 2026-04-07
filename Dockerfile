# nikolaik/python-nodejs has both Python 3.11 and Node 20 pre-installed
# — avoids unreliable NodeSource curl|bash install that was failing builds
FROM nikolaik/python-nodejs:python3.11-nodejs20

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node deps
COPY package.json ./
RUN npm install --production --no-fund --no-audit

# Source
COPY . .

EXPOSE 3000

CMD ["bash", "start.sh"]

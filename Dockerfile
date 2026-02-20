FROM node:20-slim

WORKDIR /app

# Dependências de sistema exigidas pelo Playwright
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libxss1 \
    libasound2 \
    libgbm1 \
    libxshmfence1 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Dependências Node
COPY package*.json ./
RUN npm install --omit=dev

# Playwright (instala Chromium oficial)
RUN npx playwright install chromium

# Código
COPY app ./app

# Logs em tempo real
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

CMD ["node", "app/worker.js"]

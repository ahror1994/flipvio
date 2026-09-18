FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
	poppler-utils imagemagick ghostscript python3 fonts-dejavu \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN python3 tools/make-sounds.py
ENV PORT=8080 FLIPVIO_STORAGE=/data FLIPVIO_AUTH_FILE=/data/.owner.json
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/index.js"]

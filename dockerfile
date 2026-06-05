FROM node:18-bullseye
WORKDIR /app/evidence_regions_service
COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund 

COPY . .

RUN mkdir -p /app/evidence_regions_service/data
EXPOSE 3000
USER node
CMD ["node", "index.js"]
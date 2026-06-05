FROM node:18-bullseye
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund
COPY . .
RUN mkdir -p /app/data
RUN chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "index.js"]
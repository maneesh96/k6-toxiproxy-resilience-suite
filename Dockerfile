# One image for both Node services; docker-compose picks the entrypoint script.
FROM node:22-alpine
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY gateway.js product-service.js ./
USER node

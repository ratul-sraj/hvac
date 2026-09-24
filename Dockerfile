# WebHVAC server image: the static UI plus server-side PDF parsing.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# dependencies first, so the layer is cached when only the code changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# only what the server needs (no tests, no .github, no node_modules from the host)
COPY server.js ./
COPY lib ./lib
COPY js ./js
COPY css ./css
COPY vendor ./vendor
COPY *.html favicon.svg ./
# the sample drawing the "load sample" button fetches from /samples
COPY tests/samples ./tests/samples

# run as the unprivileged user that ships with the node image
USER node

EXPOSE 3000

CMD ["node", "server.js"]

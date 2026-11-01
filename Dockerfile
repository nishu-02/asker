FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=3000 DB_PATH=/data/contacts.db NODE_NO_WARNINGS=1
VOLUME /data
CMD ["node", "server.js"]

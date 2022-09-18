FROM node:lts
WORKDIR /tmp
COPY package* ./
RUN npm ci
ENTRYPOINT ["node", "kodisync.js"]

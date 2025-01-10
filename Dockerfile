FROM node:lts
WORKDIR /tmp
COPY package* ./
RUN npm ci
COPY kodisync.js /tmp/kodisync.js
ENTRYPOINT ["node", "kodisync.js"]

FROM node:lts
WORKDIR /src/
COPY package* ./
RUN npm ci
COPY kodisync.js ./ 
ENTRYPOINT ["node", "kodisync.js"]

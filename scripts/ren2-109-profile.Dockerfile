FROM postgres:16.15-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139

RUN apk add --no-cache nodejs=24.22.1-r1 npm=11.12.1-r0
WORKDIR /opt/renivet
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
COPY scripts/ren2-109-profile-entrypoint.sh /usr/local/bin/ren2-109-profile-entrypoint
RUN chmod 0555 /usr/local/bin/ren2-109-profile-entrypoint

ENTRYPOINT ["/usr/local/bin/ren2-109-profile-entrypoint"]

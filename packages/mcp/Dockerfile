# The MCP server, containerised.
#
# It is a thin shell over the public REST API: no database driver, no credentials
# baked in, and the project write key arrives per request on the Authorization
# header. That is what makes one container safe to share across tenants.
#
# BASE IMAGE: `alpine` rather than `node:*`. Not a preference — on the machine
# this was built for, Docker Hub pulls of the official Node images hang
# indefinitely, while `alpine` is already in the local cache. Node comes from
# Alpine's own package mirror instead. Swap this for `node:24-alpine` wherever
# the registry is reachable; nothing else in the file needs to change.
FROM alpine:latest

RUN apk add --no-cache nodejs npm

WORKDIR /app
ENV NODE_ENV=production

COPY packages/mcp/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY packages/mcp/dist ./dist

# Never run as root: this process listens on a port.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]

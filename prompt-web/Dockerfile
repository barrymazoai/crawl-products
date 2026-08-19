FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY --chown=node:node prompt-web/index.html prompt-web/server.mjs ./
COPY --chown=node:node scripts/generate-prompt.mjs ./generate-prompt.mjs

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

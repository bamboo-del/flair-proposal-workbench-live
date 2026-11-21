FROM node:24-alpine
WORKDIR /app
RUN mkdir -p /var/lib/flair && chown node:node /var/lib/flair
COPY --chown=node:node package.json index.html client.html ops.html roadshow.html server.cjs store.cjs proposal.cjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node assets ./assets
COPY --chown=node:node scripts/seed-demo.cjs ./scripts/seed-demo.cjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/var/lib/flair/flair.sqlite
EXPOSE 3000
USER node
HEALTHCHECK --interval=20s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]

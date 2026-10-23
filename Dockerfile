FROM node:22-bookworm-slim

# Versão do cliente Postgres (pg_dump). Use a MESMA do seu banco no Neon ou uma MAIOR.
# Ex.: se o Neon está no Postgres 17, pode usar 17 ou 18.
ARG PG_VERSION=18

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_VERSION} \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV PG_DUMP_PATH=/usr/lib/postgresql/${PG_VERSION}/bin/pg_dump \
    NODE_ENV=production

WORKDIR /app
COPY --chown=node:node --chmod=644 package.json server.js ./

USER node
EXPOSE 3000
CMD ["node", "server.js"]

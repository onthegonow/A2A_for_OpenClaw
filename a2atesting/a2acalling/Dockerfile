FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    python3 \
    tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/a2acalling

COPY a2atesting/a2acalling/entrypoint.sh /opt/a2atesting/entrypoint.sh
COPY a2atesting/a2acalling/scenarios /opt/a2atesting/scenarios

RUN chmod +x /opt/a2atesting/entrypoint.sh

ENTRYPOINT ["/opt/a2atesting/entrypoint.sh"]

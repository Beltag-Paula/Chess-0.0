# ---------- STAGE 1: stockfish ----------
FROM ubuntu:22.04 AS stockfish

ARG STOCKFISH_MODE=download

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    unzip \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

# --- Option A: Download prebuilt ---
RUN if [ "$STOCKFISH_MODE" = "download" ]; then \
    echo "Downloading Stockfish latest release..." && \
    curl -L https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64.tar -o sf.tar && \
    tar -xf sf.tar && \
    find . -type f -name "stockfish*" -executable -exec cp {} /stockfish \; ; \
    fi

# --- Option B: Build from source ---
RUN if [ "$STOCKFISH_MODE" = "build" ]; then \
    echo "Building Stockfish from source..." && \
    git clone https://github.com/official-stockfish/Stockfish.git && \
    cd Stockfish/src && \
    make build ARCH=x86-64-modern && \
    cp stockfish /stockfish ; \
    fi

RUN chmod +x /stockfish


# ---------- STAGE 2: app ----------
FROM node:20-slim

WORKDIR /app

# install only needed runtime deps
RUN apt-get update && apt-get install -y \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# copy stockfish binary
COPY --from=stockfish /stockfish /app/engine/stockfish-bin

# copy project
COPY . .

RUN npm install --omit=dev

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

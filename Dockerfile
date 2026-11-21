FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS supervisor

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY scripts ./scripts
RUN bun build --compile --minify scripts/container.ts --outfile minecraft-container

FROM eclipse-temurin:25-jre-noble@sha256:f3dd0838e69b881cc382237d5901e74ae3705b1056ad964b2e0e523b174fef99

ARG PAPER_SHA256=64a5bd44910cb982b2648e9a35036cc95a6de4d561e15812aecf5411f84f7b01
ARG PAPER_URL=https://fill-data.papermc.io/v1/objects/64a5bd44910cb982b2648e9a35036cc95a6de4d561e15812aecf5411f84f7b01/paper-26.3-257.jar
ADD --chmod=0644 --checksum=sha256:${PAPER_SHA256} ${PAPER_URL} /opt/paper.jar
COPY --from=supervisor /build/minecraft-container /opt/minecraft-container
RUN install -d -o 1000 -g 1000 /data

USER 1000:1000
WORKDIR /data
EXPOSE 25565/tcp
ENTRYPOINT ["/opt/minecraft-container"]

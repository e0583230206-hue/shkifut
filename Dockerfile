FROM node:20 AS builder1

# Optional extra root CAs (e.g. a filtering proxy such as NetFree). Put *.crt files in ./certs.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY ./frontend/package.json ./frontend/package-lock.json ./
RUN npm install
COPY ./frontend .
RUN npm run build

FROM golang:1.24 AS builder2

COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates

WORKDIR /app

COPY ./backend/go.mod ./backend/go.sum ./
RUN go mod download
COPY ./backend .
COPY --from=builder1 /app/dist/channel/browser/favicon.ico assets
RUN go mod tidy
RUN go build -o the-channel .

FROM debian:bookworm-slim
WORKDIR /app
# Runtime image: system CAs only (extra proxy CAs from ./certs are trusted by the build stages above, never shipped).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder2 /app/the-channel .
COPY --from=builder2 /app/assets ./assets
COPY --from=builder1 /app/dist/channel/browser /usr/share/ng
RUN chmod +x the-channel
CMD ["./the-channel"]

#!/usr/bin/env bash
# Starts a throwaway PostgreSQL 16 with TLS and SCRAM authentication, for the
# certificate tests in apps/api/src/log/connection.test.ts. CI runs it on every
# pull request; locally:
#
#   scripts/postgres-tls.sh
#   TEST_DATABASE_TLS_URL=postgres://marketlab:marketlab@localhost:5433/marketlab \
#   NODE_EXTRA_CA_CERTS=$PWD/.tls/ca.crt npx vitest run apps/api/src/log/connection.test.ts
#
# A fresh CA signs a server certificate for DNS:localhost only (no IP), and the
# tests trust that CA, so connecting by 127.0.0.1 fails on the host name itself
# rather than on an unknown issuer.
set -euo pipefail

DIR="${TLS_DIR:-.tls}"
PORT="${TLS_PORT:-5433}"
NAME=marketlab-postgres-tls
IMAGE=postgres:16

docker rm -f "$NAME" >/dev/null 2>&1 || true
if [ -d "$DIR" ]; then
  # The key was handed to the container's postgres user; take it back to delete it.
  docker run --rm -v "$PWD/$DIR:/tls" --entrypoint chown "$IMAGE" -R "$(id -u):$(id -g)" /tls
  rm -rf "$DIR"
fi
mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=MarketLab test CA" \
  -keyout "$DIR/ca.key" -out "$DIR/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout "$DIR/server.key" -out "$DIR/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost\n' >"$DIR/san.ext"
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -days 2 -extfile "$DIR/san.ext" -out "$DIR/server.crt" 2>/dev/null

# PostgreSQL only reads a private key owned by its own user (999 in the image) with mode 0600.
chmod 600 "$DIR/server.key"
docker run --rm -v "$PWD/$DIR:/tls" --entrypoint chown "$IMAGE" 999:999 /tls/server.key /tls/server.crt

docker run -d --name "$NAME" -p "$PORT:5432" \
  -e POSTGRES_USER=marketlab -e POSTGRES_PASSWORD=marketlab -e POSTGRES_DB=marketlab \
  -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  -v "$PWD/$DIR:/tls:ro" "$IMAGE" \
  -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key >/dev/null

# Ready means accepting TLS over TCP; the image's first-boot setup listens on a socket only.
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql "postgres://marketlab:marketlab@localhost:5432/marketlab?sslmode=require" \
    -qtAc 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' 2>/dev/null | grep -qx t; then
    echo "PostgreSQL with TLS is ready on localhost:$PORT (CA: $DIR/ca.crt)"
    exit 0
  fi
  sleep 1
done
docker logs "$NAME"
echo "PostgreSQL with TLS did not start" >&2
exit 1

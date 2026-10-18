# Build stage
FROM rust:1.80-alpine AS builder

RUN apk add --no-cache musl-dev

WORKDIR /app
COPY . .
RUN cargo build --release

# Runtime stage
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/target/release/bkk-live-tracker /app/bkk-live-tracker

EXPOSE 8000

ENV HOST=0.0.0.0
ENV PORT=8000

CMD ["/app/bkk-live-tracker"]

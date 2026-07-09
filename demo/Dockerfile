FROM golang:1.25-alpine AS build

WORKDIR /src

COPY go.mod go.sum* ./
RUN go mod download

COPY . .

ARG SERVICE
RUN test -n "$SERVICE" && \
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/${SERVICE}

FROM alpine:3.22

RUN apk add --no-cache ca-certificates
USER 65532:65532

COPY --from=build /out/app /app

ENTRYPOINT ["/app"]

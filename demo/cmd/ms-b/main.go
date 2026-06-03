package main

import (
	"context"
	"log"
	"net"
	"os"
	"time"

	"morpheus-proxy/demo/internal/rpc"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type timeServer struct {
	rpc.UnimplementedTimeServer
}

func (timeServer) Now(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error) {
	return wrapperspb.String(time.Now().UTC().Format(time.RFC3339Nano)), nil
}

func main() {
	addr := env("GRPC_ADDR", ":50052")

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	server := grpc.NewServer()
	rpc.RegisterTimeServer(server, timeServer{})

	log.Printf("ms-b time grpc listening on %s", addr)
	if err := server.Serve(listener); err != nil {
		log.Fatalf("serve grpc: %v", err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

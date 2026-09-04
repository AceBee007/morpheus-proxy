package main

import (
	"context"
	"crypto/rand"
	"log"
	"math/big"
	"net"
	"os"
	"time"

	"morpheus-proxy/demo/internal/rpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type timeServer struct {
	rpc.UnimplementedTimeServer
	rpc.UnimplementedAnimalSoundServer
}

func (timeServer) Now(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error) {
	return wrapperspb.String(time.Now().UTC().Format(time.RFC3339Nano)), nil
}

func (timeServer) Sound(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error) {
	sounds := []string{"woof", "meow", "moo", "baa", "neigh"}
	index, err := rand.Int(rand.Reader, bigInt(len(sounds)))
	if err != nil {
		return nil, err
	}
	return wrapperspb.String(sounds[index.Int64()]), nil
}

func main() {
	addr := env("GRPC_ADDR", ":50052")

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	server := grpc.NewServer()
	service := timeServer{}
	rpc.RegisterTimeServer(server, service)
	rpc.RegisterAnimalSoundServer(server, service)
	// Server reflection lets morpheus import this server's descriptors itself
	// (docs/spec.md 4.7.6) — the same mechanism grpcurl / buf curl rely on.
	reflection.Register(server)

	log.Printf("ms-b time grpc listening on %s", addr)
	if err := server.Serve(listener); err != nil {
		log.Fatalf("serve grpc: %v", err)
	}
}

func bigInt(value int) *big.Int {
	return big.NewInt(int64(value))
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

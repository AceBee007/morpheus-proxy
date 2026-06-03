package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"morpheus-proxy/demo/internal/rpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type echoServer struct {
	rpc.UnimplementedEchoServer
	timeConn *grpc.ClientConn
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

type echoResponse struct {
	Message      string `json:"message"`
	UpstreamTime string `json:"upstream_time"`
	ServedBy     string `json:"served_by"`
	Protocol     string `json:"protocol"`
}

func (s echoServer) Echo(ctx context.Context, req *wrapperspb.StringValue) (*structpb.Struct, error) {
	response, err := s.echo(ctx, req.Value, "grpc")
	if err != nil {
		return nil, err
	}
	return structpb.NewStruct(map[string]interface{}{
		"message":       response.Message,
		"upstream_time": response.UpstreamTime,
		"served_by":     response.ServedBy,
		"protocol":      response.Protocol,
	})
}

func (s echoServer) httpEcho(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/echo" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	message, err := messageFromRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	response, err := s.echo(ctx, message, "http")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("write http response: %v", err)
	}
}

func (s echoServer) echo(ctx context.Context, message, protocol string) (echoResponse, error) {
	upstreamTime, err := rpc.InvokeNow(ctx, s.timeConn)
	if err != nil {
		return echoResponse{}, err
	}
	return echoResponse{
		Message:      message,
		UpstreamTime: upstreamTime,
		ServedBy:     "ms-a",
		Protocol:     protocol,
	}, nil
}

func main() {
	httpAddr := env("HTTP_ADDR", ":8080")
	grpcAddr := env("GRPC_ADDR", ":50051")
	timeAddr := env("MS_B_ADDR", "127.0.0.1:50052")
	grpcProxyAddr := os.Getenv("GRPC_PROXY_ADDR")

	dialOptions := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	if grpcProxyAddr != "" {
		dialOptions = append(dialOptions, grpc.WithContextDialer(connectProxyDialer(grpcProxyAddr)))
	}

	timeConn, err := grpc.NewClient(timeAddr, dialOptions...)
	if err != nil {
		log.Fatalf("create time grpc client for %s: %v", timeAddr, err)
	}
	defer timeConn.Close()

	server := echoServer{timeConn: timeConn}
	errs := make(chan error, 2)

	go func() {
		listener, err := net.Listen("tcp", grpcAddr)
		if err != nil {
			errs <- err
			return
		}
		grpcServer := grpc.NewServer()
		rpc.RegisterEchoServer(grpcServer, server)
		log.Printf("ms-a echo grpc listening on %s, time upstream %s, proxy %s", grpcAddr, timeAddr, grpcProxyAddr)
		errs <- grpcServer.Serve(listener)
	}()

	go func() {
		httpServer := &http.Server{
			Addr:              httpAddr,
			Handler:           httpHandler(server),
			ReadHeaderTimeout: 5 * time.Second,
		}
		log.Printf("ms-a echo http listening on %s, time upstream %s, proxy %s", httpAddr, timeAddr, grpcProxyAddr)
		errs <- httpServer.ListenAndServe()
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	select {
	case signal := <-sig:
		log.Printf("shutting down on %s", signal)
	case err := <-errs:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	}
}

func (c bufferedConn) Read(p []byte) (int, error) {
	if c.reader.Buffered() > 0 {
		return c.reader.Read(p)
	}
	return c.Conn.Read(p)
}

func connectProxyDialer(proxyAddr string) func(context.Context, string) (net.Conn, error) {
	return func(ctx context.Context, targetAddr string) (net.Conn, error) {
		dialer := &net.Dialer{}
		conn, err := dialer.DialContext(ctx, "tcp", proxyAddr)
		if err != nil {
			return nil, err
		}

		if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", targetAddr, targetAddr); err != nil {
			conn.Close()
			return nil, err
		}

		reader := bufio.NewReader(conn)
		response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
		if err != nil {
			conn.Close()
			return nil, err
		}
		defer response.Body.Close()

		if response.StatusCode != http.StatusOK {
			conn.Close()
			return nil, fmt.Errorf("proxy connect to %s via %s failed: %s", targetAddr, proxyAddr, response.Status)
		}

		return bufferedConn{Conn: conn, reader: reader}, nil
	}
}

func httpHandler(server echoServer) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/echo", server.httpEcho)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

func messageFromRequest(r *http.Request) (string, error) {
	if message := r.URL.Query().Get("message"); message != "" {
		return message, nil
	}

	if r.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(body)), nil
	}

	return "", nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

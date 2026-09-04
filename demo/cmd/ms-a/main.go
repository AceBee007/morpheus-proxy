package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"morpheus-proxy/demo/internal/rpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type echoServer struct {
	rpc.UnimplementedEchoServer
	timeConn        *grpc.ClientConn
	animalSoundConn *grpc.ClientConn
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

type echoResponse struct {
	Message      string `json:"message"`
	UpstreamTime string `json:"upstream_time"`
	AnimalSound  string `json:"animal_sound"`
	ServedBy     string `json:"served_by"`
	Protocol     string `json:"protocol"`
}

type metadataIDTokenCredentials struct {
	audience string
}

func (s echoServer) Echo(ctx context.Context, req *wrapperspb.StringValue) (*structpb.Struct, error) {
	response, err := s.echo(ctx, req.Value, "grpc")
	if err != nil {
		return nil, err
	}
	return structpb.NewStruct(map[string]interface{}{
		"message":       response.Message,
		"upstream_time": response.UpstreamTime,
		"animal_sound":  response.AnimalSound,
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
	animalSound, err := rpc.InvokeAnimalSound(ctx, s.animalSoundConn)
	if err != nil {
		return echoResponse{}, err
	}
	return echoResponse{
		Message:      fmt.Sprintf("%s %s %s", upstreamTime, message, animalSound),
		UpstreamTime: upstreamTime,
		AnimalSound:  animalSound,
		ServedBy:     "ms-a",
		Protocol:     protocol,
	}, nil
}

func main() {
	httpAddr := env("HTTP_ADDR", ":8080")
	grpcAddr := env("GRPC_ADDR", ":50051")
	timeAddr := env("MS_B_ADDR", "127.0.0.1:50052")
	animalSoundAddr := env("MS_B_ANIMAL_SOUND_ADDR", timeAddr)
	grpcProxyAddr := os.Getenv("GRPC_PROXY_ADDR")
	timeDialOptions, err := grpcDialOptions(timeAddr, grpcProxyAddr)
	if err != nil {
		log.Fatalf("configure time grpc client for %s: %v", timeAddr, err)
	}

	// Route the animal-sound downstream through the same proxy (if any) as the
	// time downstream, so both ms-a -> ms-b calls are intercepted when
	// GRPC_PROXY_ADDR is set (docs/spec.md 4.14).
	animalSoundDialOptions, err := grpcDialOptions(animalSoundAddr, grpcProxyAddr)
	if err != nil {
		log.Fatalf("configure animal sound grpc client for %s: %v", animalSoundAddr, err)
	}

	timeConn, err := grpc.NewClient(timeAddr, timeDialOptions...)
	if err != nil {
		log.Fatalf("create time grpc client for %s: %v", timeAddr, err)
	}
	defer timeConn.Close()

	animalSoundConn, err := grpc.NewClient(animalSoundAddr, animalSoundDialOptions...)
	if err != nil {
		log.Fatalf("create animal sound grpc client for %s: %v", animalSoundAddr, err)
	}
	defer animalSoundConn.Close()

	server := echoServer{timeConn: timeConn, animalSoundConn: animalSoundConn}
	errs := make(chan error, 2)

	go func() {
		listener, err := net.Listen("tcp", grpcAddr)
		if err != nil {
			errs <- err
			return
		}
		grpcServer := grpc.NewServer()
		rpc.RegisterEchoServer(grpcServer, server)
		reflection.Register(grpcServer) // descriptors discoverable via server reflection (spec 4.7.6)
		log.Printf("ms-a echo grpc listening on %s, time upstream %s, animal sound upstream %s, proxy %s", grpcAddr, timeAddr, animalSoundAddr, grpcProxyAddr)
		errs <- grpcServer.Serve(listener)
	}()

	go func() {
		httpServer := &http.Server{
			Addr:              httpAddr,
			Handler:           httpHandler(server),
			ReadHeaderTimeout: 5 * time.Second,
		}
		log.Printf("ms-a echo http listening on %s, time upstream %s, animal sound upstream %s, proxy %s", httpAddr, timeAddr, animalSoundAddr, grpcProxyAddr)
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

func grpcDialOptions(targetAddr, grpcProxyAddr string) ([]grpc.DialOption, error) {
	if !envBool("MS_B_TLS") {
		dialOptions := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
		if grpcProxyAddr != "" {
			dialOptions = append(dialOptions, grpc.WithContextDialer(connectProxyDialer(grpcProxyAddr)))
		}
		return dialOptions, nil
	}

	host, err := hostFromTarget(targetAddr)
	if err != nil {
		return nil, err
	}

	dialOptions := []grpc.DialOption{
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: host,
		})),
	}
	if audience := os.Getenv("MS_B_AUTH_AUDIENCE"); audience != "" {
		dialOptions = append(dialOptions, grpc.WithPerRPCCredentials(metadataIDTokenCredentials{audience: audience}))
	}
	return dialOptions, nil
}

func hostFromTarget(targetAddr string) (string, error) {
	if parsed, err := url.Parse(targetAddr); err == nil && parsed.Hostname() != "" {
		return parsed.Hostname(), nil
	}
	host, _, err := net.SplitHostPort(targetAddr)
	if err == nil {
		return host, nil
	}
	if strings.Count(targetAddr, ":") == 0 {
		return targetAddr, nil
	}
	return "", fmt.Errorf("target %q must include a host name", targetAddr)
}

func (c metadataIDTokenCredentials) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	token, err := metadataIDToken(ctx, c.audience)
	if err != nil {
		return nil, err
	}
	return map[string]string{"authorization": "Bearer " + token}, nil
}

func (metadataIDTokenCredentials) RequireTransportSecurity() bool {
	return true
}

func metadataIDToken(ctx context.Context, audience string) (string, error) {
	requestURL := "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
		url.QueryEscape(audience)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Metadata-Flavor", "Google")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata identity token request failed: %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return strings.TrimSpace(string(body)), nil
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

func envBool(key string) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

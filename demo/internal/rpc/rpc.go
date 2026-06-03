package rpc

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	EchoMethod        = "/demo.EchoService/Echo"
	NowMethod         = "/demo.TimeService/Now"
	AnimalSoundMethod = "/demo.AnimalSoundService/Sound"
)

type EchoServer interface {
	Echo(context.Context, *wrapperspb.StringValue) (*structpb.Struct, error)
}

type TimeServer interface {
	Now(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error)
}

type AnimalSoundServer interface {
	Sound(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error)
}

type UnimplementedEchoServer struct{}

func (UnimplementedEchoServer) Echo(context.Context, *wrapperspb.StringValue) (*structpb.Struct, error) {
	return nil, status.Error(codes.Unimplemented, "method Echo not implemented")
}

type UnimplementedTimeServer struct{}

func (UnimplementedTimeServer) Now(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error) {
	return nil, status.Error(codes.Unimplemented, "method Now not implemented")
}

type UnimplementedAnimalSoundServer struct{}

func (UnimplementedAnimalSoundServer) Sound(context.Context, *emptypb.Empty) (*wrapperspb.StringValue, error) {
	return nil, status.Error(codes.Unimplemented, "method Sound not implemented")
}

func RegisterEchoServer(registrar grpc.ServiceRegistrar, server EchoServer) {
	registrar.RegisterService(&EchoServiceDesc, server)
}

func RegisterTimeServer(registrar grpc.ServiceRegistrar, server TimeServer) {
	registrar.RegisterService(&TimeServiceDesc, server)
}

func RegisterAnimalSoundServer(registrar grpc.ServiceRegistrar, server AnimalSoundServer) {
	registrar.RegisterService(&AnimalSoundServiceDesc, server)
}

func InvokeEcho(ctx context.Context, conn grpc.ClientConnInterface, message string, opts ...grpc.CallOption) (*structpb.Struct, error) {
	out := new(structpb.Struct)
	if err := conn.Invoke(ctx, EchoMethod, wrapperspb.String(message), out, opts...); err != nil {
		return nil, err
	}
	return out, nil
}

func InvokeNow(ctx context.Context, conn grpc.ClientConnInterface, opts ...grpc.CallOption) (string, error) {
	out := new(wrapperspb.StringValue)
	if err := conn.Invoke(ctx, NowMethod, &emptypb.Empty{}, out, opts...); err != nil {
		return "", err
	}
	return out.Value, nil
}

func InvokeAnimalSound(ctx context.Context, conn grpc.ClientConnInterface, opts ...grpc.CallOption) (string, error) {
	out := new(wrapperspb.StringValue)
	if err := conn.Invoke(ctx, AnimalSoundMethod, &emptypb.Empty{}, out, opts...); err != nil {
		return "", err
	}
	return out.Value, nil
}

var EchoServiceDesc = grpc.ServiceDesc{
	ServiceName: "demo.EchoService",
	HandlerType: (*EchoServer)(nil),
	Methods: []grpc.MethodDesc{
		{
			MethodName: "Echo",
			Handler:    echoHandler,
		},
	},
	Streams:  []grpc.StreamDesc{},
	Metadata: "proto/demo.proto",
}

var TimeServiceDesc = grpc.ServiceDesc{
	ServiceName: "demo.TimeService",
	HandlerType: (*TimeServer)(nil),
	Methods: []grpc.MethodDesc{
		{
			MethodName: "Now",
			Handler:    nowHandler,
		},
	},
	Streams:  []grpc.StreamDesc{},
	Metadata: "proto/demo.proto",
}

var AnimalSoundServiceDesc = grpc.ServiceDesc{
	ServiceName: "demo.AnimalSoundService",
	HandlerType: (*AnimalSoundServer)(nil),
	Methods: []grpc.MethodDesc{
		{
			MethodName: "Sound",
			Handler:    animalSoundHandler,
		},
	},
	Streams:  []grpc.StreamDesc{},
	Metadata: "proto/demo.proto",
}

func echoHandler(server interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
	in := new(wrapperspb.StringValue)
	if err := dec(in); err != nil {
		return nil, err
	}
	if interceptor == nil {
		return server.(EchoServer).Echo(ctx, in)
	}

	info := &grpc.UnaryServerInfo{
		Server:     server,
		FullMethod: EchoMethod,
	}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return server.(EchoServer).Echo(ctx, req.(*wrapperspb.StringValue))
	}
	return interceptor(ctx, in, info, handler)
}

func nowHandler(server interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
	in := new(emptypb.Empty)
	if err := dec(in); err != nil {
		return nil, err
	}
	if interceptor == nil {
		return server.(TimeServer).Now(ctx, in)
	}

	info := &grpc.UnaryServerInfo{
		Server:     server,
		FullMethod: NowMethod,
	}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return server.(TimeServer).Now(ctx, req.(*emptypb.Empty))
	}
	return interceptor(ctx, in, info, handler)
}

func animalSoundHandler(server interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
	in := new(emptypb.Empty)
	if err := dec(in); err != nil {
		return nil, err
	}
	if interceptor == nil {
		return server.(AnimalSoundServer).Sound(ctx, in)
	}

	info := &grpc.UnaryServerInfo{
		Server:     server,
		FullMethod: AnimalSoundMethod,
	}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return server.(AnimalSoundServer).Sound(ctx, req.(*emptypb.Empty))
	}
	return interceptor(ctx, in, info, handler)
}

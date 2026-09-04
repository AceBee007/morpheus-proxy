package rpc

import (
	"fmt"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
)

// The demo services are hand-written (no protoc step), so the file descriptor
// that generated code would normally embed is assembled here and registered in
// the global registry. That is what lets gRPC server reflection
// (grpc.reflection.v1, spec 4.7.6) resolve `demo.*` symbols and hand morpheus a
// descriptor set — the same data protoc-generated code registers on init.
// It mirrors proto/demo.proto; keep the two in sync.
func init() {
	method := func(name, in, out string) *descriptorpb.MethodDescriptorProto {
		return &descriptorpb.MethodDescriptorProto{
			Name:       proto.String(name),
			InputType:  proto.String(in),
			OutputType: proto.String(out),
		}
	}
	file := &descriptorpb.FileDescriptorProto{
		Name:    proto.String("proto/demo.proto"),
		Package: proto.String("demo"),
		Syntax:  proto.String("proto3"),
		Dependency: []string{
			"google/protobuf/empty.proto",
			"google/protobuf/struct.proto",
			"google/protobuf/wrappers.proto",
		},
		Options: &descriptorpb.FileOptions{GoPackage: proto.String("morpheus-proxy/demo/internal/rpc")},
		Service: []*descriptorpb.ServiceDescriptorProto{
			{
				Name:   proto.String("EchoService"),
				Method: []*descriptorpb.MethodDescriptorProto{method("Echo", ".google.protobuf.StringValue", ".google.protobuf.Struct")},
			},
			{
				Name:   proto.String("TimeService"),
				Method: []*descriptorpb.MethodDescriptorProto{method("Now", ".google.protobuf.Empty", ".google.protobuf.StringValue")},
			},
			{
				Name:   proto.String("AnimalSoundService"),
				Method: []*descriptorpb.MethodDescriptorProto{method("Sound", ".google.protobuf.Empty", ".google.protobuf.StringValue")},
			},
		},
	}
	// The well-known dependencies are registered by the emptypb / structpb /
	// wrapperspb packages imported in rpc.go, whose init runs before this one.
	desc, err := protodesc.NewFile(file, protoregistry.GlobalFiles)
	if err != nil {
		panic(fmt.Sprintf("demo: build file descriptor: %v", err))
	}
	if err := protoregistry.GlobalFiles.RegisterFile(desc); err != nil {
		panic(fmt.Sprintf("demo: register file descriptor: %v", err))
	}
}

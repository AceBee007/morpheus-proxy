/**
 * gRPC Server Reflection protocol definitions (spec 4.7.6).
 *
 * The reflection service is defined by the gRPC project
 * (grpc/grpc-proto: grpc/reflection/v1/reflection.proto). `v1alpha` is the
 * older, deprecated revision that many servers and tools still speak; its
 * messages are identical to `v1` apart from the package name, so both are
 * generated from the same source template.
 */
import protobuf from 'protobufjs';

export type ReflectionProtocol = 'grpc-v1' | 'grpc-v1alpha';

/** Newest first: clients try `v1` and fall back to `v1alpha` (like grpcurl / buf curl). */
export const REFLECTION_PROTOCOLS: readonly ReflectionProtocol[] = ['grpc-v1', 'grpc-v1alpha'];

const PACKAGE: Record<ReflectionProtocol, string> = {
  'grpc-v1': 'grpc.reflection.v1',
  'grpc-v1alpha': 'grpc.reflection.v1alpha',
};

/** Fully qualified reflection service names, excluded from descriptor imports. */
export const REFLECTION_SERVICE_NAMES: ReadonlySet<string> = new Set(
  REFLECTION_PROTOCOLS.map((protocol) => `${PACKAGE[protocol]}.ServerReflection`),
);

/** The `.proto` source of the reflection service for `protocol`. */
export function reflectionProtoSource(protocol: ReflectionProtocol): string {
  return `syntax = "proto3";
package ${PACKAGE[protocol]};

service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}

message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}

message ExtensionRequest {
  string containing_type = 1;
  int32 extension_number = 2;
}

message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}

message FileDescriptorResponse {
  repeated bytes file_descriptor_proto = 1;
}

message ExtensionNumberResponse {
  string base_type_name = 1;
  repeated int32 extension_number = 2;
}

message ListServiceResponse {
  repeated ServiceResponse service = 1;
}

message ServiceResponse {
  string name = 1;
}

message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
`;
}

/** gRPC :path of the reflection RPC for `protocol`. */
export function reflectionMethodPath(protocol: ReflectionProtocol): string {
  return `/${PACKAGE[protocol]}.ServerReflection/ServerReflectionInfo`;
}

export interface ReflectionTypes {
  request: protobuf.Type;
  response: protobuf.Type;
}

const typeCache = new Map<ReflectionProtocol, ReflectionTypes>();

/** Parsed request / response message types for `protocol` (cached). */
export function reflectionTypes(protocol: ReflectionProtocol): ReflectionTypes {
  const cached = typeCache.get(protocol);
  if (cached) return cached;
  const root = new protobuf.Root();
  protobuf.parse(reflectionProtoSource(protocol), root, { keepCase: true });
  root.resolveAll();
  const types: ReflectionTypes = {
    request: root.lookupType(`${PACKAGE[protocol]}.ServerReflectionRequest`),
    response: root.lookupType(`${PACKAGE[protocol]}.ServerReflectionResponse`),
  };
  typeCache.set(protocol, types);
  return types;
}

/**
 * Services every gRPC server may expose besides its own API. They are never
 * imported as descriptors (there is nothing to mock or manipulate in them).
 */
export function isInfrastructureService(fullName: string): boolean {
  return (
    REFLECTION_SERVICE_NAMES.has(fullName) ||
    fullName.startsWith('grpc.health.') ||
    fullName.startsWith('grpc.channelz.')
  );
}

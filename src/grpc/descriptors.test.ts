import { describe, expect, it } from 'vitest';
import { DescriptorError, DescriptorRegistry } from './descriptors.js';

const PLAIN_PROTO = `syntax = "proto3";
package t;
service Svc { rpc Get (Req) returns (Res); }
message Req { string id = 1; }
message Res { string name = 1; }
`;

// Mirrors real-world protos (like demo/proto/demo.proto) that import
// well-known types — historically unsupported by bare protobuf.parse.
const WELL_KNOWN_PROTO = `syntax = "proto3";
package demo;

import "google/protobuf/empty.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/wrappers.proto";

service EchoService {
  rpc Echo(google.protobuf.StringValue) returns (google.protobuf.Struct);
}

service TimeService {
  rpc Now(google.protobuf.Empty) returns (google.protobuf.StringValue);
}
`;

describe('DescriptorRegistry proto_source', () => {
  it('registers a plain proto and resolves its methods', () => {
    const registry = new DescriptorRegistry();
    const info = registry.add({ name: 'plain', format: 'proto_source', content: PLAIN_PROTO });
    expect(info.services[0]?.fullName).toBe('t.Svc');
    const method = registry.lookupMethod('/t.Svc/Get');
    expect(method?.requestType.fullName).toBe('.t.Req');
    expect(method?.responseType.fullName).toBe('.t.Res');
  });

  it('registers protos importing well-known types (spec 4.7.3)', () => {
    const registry = new DescriptorRegistry();
    const info = registry.add({
      name: 'demo.proto',
      format: 'proto_source',
      content: WELL_KNOWN_PROTO,
    });
    expect(info.services.map((s) => s.fullName).sort()).toEqual([
      'demo.EchoService',
      'demo.TimeService',
    ]);
    const now = registry.lookupMethod('/demo.TimeService/Now');
    expect(now?.requestType.fullName).toBe('.google.protobuf.Empty');
    expect(now?.responseType.fullName).toBe('.google.protobuf.StringValue');
  });

  it('encodes and decodes well-known wrapper messages round-trip', () => {
    const registry = new DescriptorRegistry();
    registry.add({ name: 'demo.proto', format: 'proto_source', content: WELL_KNOWN_PROTO });
    const now = registry.lookupMethod('/demo.TimeService/Now');
    if (!now) throw new Error('method not found');

    // Empty request
    const emptyBytes = registry.encodeMessage(now.requestType, {});
    expect(registry.decodeMessage(now.requestType, emptyBytes)).toEqual({});

    // StringValue response
    const bytes = registry.encodeMessage(now.responseType, { value: '2026-06-10T00:00:00Z' });
    expect(registry.decodeMessage(now.responseType, bytes)).toEqual({
      value: '2026-06-10T00:00:00Z',
    });
  });

  it('rejects mocks that do not match a wrapper schema', () => {
    const registry = new DescriptorRegistry();
    registry.add({ name: 'demo.proto', format: 'proto_source', content: WELL_KNOWN_PROTO });
    const now = registry.lookupMethod('/demo.TimeService/Now');
    if (!now) throw new Error('method not found');
    expect(() => registry.encodeMessage(now.responseType, { value: 123 })).toThrow(DescriptorError);
  });

  it('still fails clearly for imports it cannot resolve', () => {
    const registry = new DescriptorRegistry();
    expect(() =>
      registry.add({
        name: 'broken',
        format: 'proto_source',
        content: `syntax = "proto3";
import "acme/private/types.proto";
package t;
service Svc { rpc Get (acme.Custom) returns (acme.Custom); }
`,
      }),
    ).toThrow(/unresolved|no such type|acme/i);
  });

  it('lookupMethod distinguishes services across multiple registered descriptors', () => {
    const registry = new DescriptorRegistry();
    registry.add({ name: 'plain', format: 'proto_source', content: PLAIN_PROTO });
    registry.add({ name: 'demo', format: 'proto_source', content: WELL_KNOWN_PROTO });
    expect(registry.lookupMethod('/t.Svc/Get')).not.toBeNull();
    expect(registry.lookupMethod('/demo.EchoService/Echo')).not.toBeNull();
    expect(registry.lookupMethod('/demo.EchoService/Nope')).toBeNull();
    expect(registry.lookupMethod('not-a-grpc-path')).toBeNull();
  });
});

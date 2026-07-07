/**
 * morpheus-proxy entrypoint.
 *
 * Boots the proxy listeners and the admin server based on the resolved
 * configuration (see docs/spec.md section 4.13).
 */
async function main(): Promise<void> {
  // Wired up incrementally: config loading, listeners, admin server.
  process.stdout.write('morpheus-proxy: scaffolding only, implementation in progress\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

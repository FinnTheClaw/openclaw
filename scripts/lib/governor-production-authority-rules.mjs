export const FORBIDDEN_AUTHORITY_EXPORTS = new Set([
  "createGovernorMemoryAuthority",
  "closeGovernorMemoryAuthority",
  "isTrustedGovernorMemoryAuthority",
  "createGovernorTestHostBindings",
  "createGovernorTestBindings",
  "createGovernorTestBroker",
  "createGovernorTestStore",
  "syntheticGovernorSecretsEnvironment",
]);

export const FORBIDDEN_TEST_FACTORY_MARKERS = new Set([
  "createGovernorTestHostBindings",
  "createGovernorTestBindings",
  "createGovernorTestBroker",
  "createGovernorTestStore",
  "syntheticGovernorSecretsEnvironment",
]);

export const AUTHORITY_KERNEL_MARKERS = new Set([
  "createGovernorMemoryAuthority",
  "closeGovernorMemoryAuthority",
  "isTrustedGovernorMemoryAuthority",
  "MEMORY_AUTHORITIES",
  "createGovernorHostPersistence",
  "createMemoryAuthorityOwner",
]);

export const ALLOWED_AUTHORITY_BEARING_EXPORTS = new Set([
  "createGovernorHostRuntimeIfEnabled",
]);

export function collectGovernorTarEntryErrors(files) {
  const errors = [];
  for (const file of files) {
    const normalizedFile = file.replace(/\\/gu, "/");
    if (
      /^(?:dist|src)\/(?:security|tasks\/governor)\/test-helpers(?:\/|$)/iu.test(normalizedFile) ||
      /^(?:dist|src)\/(?:security|tasks\/governor)\/[^/]*test-helpers?(?:-[^/.]+)?(?:\.[^/]*)?$/iu.test(
        normalizedFile,
      ) ||
      /^dist\/(?:governor-test-host-bindings|test-broker)(?:-[^/.]+)?\.js$/iu.test(
        normalizedFile,
      ) ||
      /^(?:dist|src)\/(?:security|tasks\/governor)\/[^/]*(?:test-broker|governor-test-host-bindings)(?:-[^/.]+)?(?:\.[^/]*)?$/iu.test(
        normalizedFile,
      )
    ) {
      errors.push(`forbidden governor test-helper tar entry ${normalizedFile}`);
    }
    if (
      /^src\/security\/governor-host-(?:memory-authority|persistence|broker|readonly)\.[cm]?[jt]s$/u.test(
        normalizedFile,
      )
    ) {
      errors.push(`forbidden governor source authority tar entry ${normalizedFile}`);
    }
  }
  return errors;
}

// PRF inputs for create/get when lib.dom is incomplete.
// Outputs use lib.dom AuthenticationExtensionsPRFValues if present.

interface AuthenticationExtensionsPRFValues {
  first: BufferSource;
  second?: BufferSource;
}

interface AuthenticationExtensionsPRFInputs {
  eval?: AuthenticationExtensionsPRFValues;
  evalByCredential?: Record<string, AuthenticationExtensionsPRFValues>;
}

interface AuthenticationExtensionsPRFOutputs {
  enabled?: boolean;
  results?: AuthenticationExtensionsPRFValues;
}

interface AuthenticationExtensionsClientInputs {
  prf?: AuthenticationExtensionsPRFInputs;
}

interface AuthenticationExtensionsClientOutputs {
  prf?: AuthenticationExtensionsPRFOutputs;
}

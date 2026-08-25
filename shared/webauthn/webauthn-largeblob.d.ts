// largeBlob types: present in newer lib.dom, missing in older TS used by pkg build.
// Named apart from largeBlob.ts so tsc treats this as a global augment, not that module's .d.ts.

interface AuthenticationExtensionsLargeBlobInputs {
  read?: boolean;
  support?: string;
  write?: BufferSource;
}

interface AuthenticationExtensionsLargeBlobOutputs {
  blob?: ArrayBuffer;
  supported?: boolean;
  written?: boolean;
}

interface AuthenticationExtensionsClientInputs {
  largeBlob?: AuthenticationExtensionsLargeBlobInputs;
}

interface AuthenticationExtensionsClientOutputs {
  largeBlob?: AuthenticationExtensionsLargeBlobOutputs;
}

// largeBlob types: present in newer lib.dom, missing in TS 5.8 used by pkg build.
// Ambient merge keeps seed.ts typecheck on both.

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

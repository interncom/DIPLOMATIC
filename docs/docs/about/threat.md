# Threat Model

## Data Loss

### Threats

- A user may lose a device with their app data on it.
- A host may be destroyed by a meteor impact.

### Mitigations

DIPLOMATIC keeps a full copy of the data needed to reconstruct the latest application state on all of a user's devices and hosts.

## Honest-but-Curious Host

### Threats

- A host (operated by a third party) may inspect the data on its servers.
- A third party host may be compelled to disclose the contents of its servers to another party.
- A hacker may gain access to a host's data.

### Mitigations

DIPLOMATIC encrypts application data before it leaves a user's device, so hosts do not hold any sensitive information.

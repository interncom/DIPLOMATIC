# Sync Architecture

The DIPLOMATIC protocol achieves eventual consistency across a user's client devices, without ever requiring manual intervention to resolve conflicts. It uses an event-sourcing model, encoding changes to system state in "[messages](./entdb#messages-messages)" (messages). DIPLOMATIC clients relay messages within encrypted "[bags](./entdb#bags)" via untrusted hosts, with each message uniquely encrypted per-host, to prevent cross-host tracking of users.

## Phases

Sync happens in three phases:

1. [PEEK](../api/peek) -- Fetch bag headers from host.
2. [PUSH](../api/push) -- Upload bags to host.
3. [PULL](../api/pull) -- Download bag bodies from host.

## SEQs

Hosts index bags by `(user, seq)`, where `seq` is an incrementing count (autoint). Clients track the maximum `seq` they've downloaded for each host, then provide that as a parameter to PEEK requests to filter for only bags with higher (unseen) seqs. To fetch bag contents, clients issue a PULL request with a list of seqs as input.

## Consistency

When all clients have processed the same set of messages, they will all achieve identical views of the system state (user's database).

The DIPLOMATIC system state is an object database. We call each object an "ent", short for "entity". Each ent as an id, called its `eid`. Each message contains an `eid` and a complete copy of the new state of the corresponding ent at the message's time of creation.

When a DIPLOMATIC client receives a new message, it applies that message to its current view of the system state. The client compares the incoming message to the most-recent message recorded (if any) for the same eid. If the incoming message is newer than the previous most-recent message, or no prior one exists, the DIPLOMATIC client upserts (inserts or overwrites) the entity with the message's eid with the contents of the message body. This is called Last Write Wins (LWW).

Following this procedure, when all clients have the same set of messages, regardless of the order they received the messages in, all client state will have the same set of ents each with contents set to that of the latest message with corresponding eid.

### Ordering

That state update procedure requires a mechanism to order messages by recency. DIPLOMATIC orders messages using hybrid logical clock (HLC): a timestamp paired with an ent-specific counter. When a client creates an message, it sets the HLC's time component to be its view of the current time, and sets the counter component to the maximum counter it has seen for that ent, plus 1. The counter ensures that multiple events happening at the same time (e.g. high-frequency measurements) are still ordered correctly.

### Conflicts

If multiple devices generate messages for the same ent in parallel, there can be conflicts. DIPLOMATIC is explicitly not designed for this case of concurrent message generation on multiple devices. DIPLOMATIC is designed to be the best system for securely synchronizing a single user's activity across devices. A single user switches between devices sequentially. A single user does not take actions on two devices simultaneously. If a user modifies the same ent on two devices while disconnected, whatever they did last is probably what they want. DIPLOMATIC automatically resolves conflicts using the last-write wins (LWW) rule.

### Clock Skew

If one of the user's device clocks is set to the future relative to their other devices, the device living in the future will generate messages that consistently overwrite messages from the other devices. The term for this is "clock skew". DIPLOMATIC relies on accurate clocks to correctly order messages, so clock skew is a (theoretical) problem.

In practice, phones, laptops, etc... have well-synchronized clocks. Remember that DIPLOMATIC is designed to synchronize a single user's data. In that scenario, for clock skew to cause a problem, a user would have to mutate an ent on one device, then switch to another device and mutate the exact same ent in less time than the clock skew between their devices. In practical testing for over a year, with an [app](https://life.interncom.org/) built on this architecture, skew has never been an issue.

In the rare case that clock-skew does occur, it will only cause a conflict if one client attempts to create a message mutatating an ent that has been mutated "in the future" (has a timestamp greater than the client's current time). In that case, the client creating the new message knows that a state of clock-skew exists. It does not know whether it's own clock is behind or whether the client which last updated the ent has a clock running in the future. By default, DIPLOMATIC clients will handle this situation automatically, but can be configured to just fail with an error when trying to create a message while in a clock-skew state.

Automatic clock skew handling works by deleting and replacing the "skewed" ent. To streamline detecting this case in the message history, the skewed ent and its replacement both have identical ID portions of their [EID](../api/push#eid-data-structure)s. The timestamp portion of the replacement's EID will be later than the timestamp of the skewed ent's EID. This approach allows a client to make progress, even when in a state of clock-skew. It does not resolve the underlying problem, though.

To end the state of clock-skew, DIPLOMATIC relies on client devices synchronizing their clocks to a standard time that all of the user's devices agree on. Modern phones, tablets, and computers use [NTP](https://datatracker.ietf.org/doc/html/rfc5905) to synchronize time automatically. As an additional layer of defense against clock-skew, in each API request to a DIPLOMATIC host, the client provides its view of the current time, and the host returns an error if the client's time is too far from the hosts own view of current time. Additionally, the host returns NTP-like timestamps for when it received the client's request and when it sent its own response, allowing the client to compute its time offset from the host. If the client wants to ensure its request is processed despite the skew between client and host, it can retry the request with its auth timestamp adjusted by the delta it computes from the host's time. A safer approach in this case is for client applications to notify the user that there's a time issue, and instruct the user to check their device clock is correct, then either fix it or tell the host to fix their clock as appropriate.

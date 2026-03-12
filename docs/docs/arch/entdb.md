# EntDB (Entity Database)

##  Protocol Layers

### Msgs (Messages)

The atomic unit of the DIPLOMATIC protocol is the message, abbreviated msg. A message is an update (insert, update, or delete) to an application data object. Each message carries with it the complete state of the object, as well as metadata necessary to achieve consistent ordering of messages, to achieve an eventually consistent state of application data objects across all devices.

### Ents (Entities)

In DIPLOMATIC, we call these application data objects "ents", short for "entities". As applications receive new messages, they update their entities to reflect the latest state of each application data object encoded in the messages.

EntDB adds concepts on top of the raw DIPLOMATIC protocol:

1. "type" - Mandatory. Groups ents by their application-defined type.
2. "pid" (parent ID) - Optional. Encodes a hierarchy amongst ents.
3. "gid" (group ID) - Optional. Supports non-hierarchical grouping.

These are [msgpack](https://msgpack.org)-encoded within the DIPLOMATIC msg body. The rest of the ent data lives alongside those, encoded the same way.

### Bags

The DIPLOMATIC relays messages via untrusted hosts. To secure messages when on hosts, DIPLOMATIC wraps them in bags, as in "diplomatic bags" immune from inspection. [Laws of Man](https://www.state.gov/diplomatic-pouches) secure the contents of diplomatic bags. [Laws of Math](https://datatracker.ietf.org/doc/html/rfc8439) secure the contents of DIPLOMATIC bags.

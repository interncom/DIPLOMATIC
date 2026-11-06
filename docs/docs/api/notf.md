# NOTF

The NOTF endpoint connects a WebSocket listener to receive real-time notifications when new bags are [PUSH](./push)-ed to the host.

To connect to the NOTF endpoint, a client sends an HTTP request with the `upgrade` header set to `websocket`, and a URL query parameter `t` containing a hex-encoded [authTS](../arch/auth) struct.

If the authentication succeeds, the host establishes the WebSocket and assigns a connID: the lowest positive integer not in use by that user's other sockets. Each message the host sends starts with a type varint of at most one byte, so the assignment and a notif can arrive in either order. Type 1 is the assignment. Its body is the connID, a varint of at most two bytes (1 through 16383). Type 2 is a notif batch. Any other type is ignored. A longer varint is `VarLimitExceeded`. A disconnected id may be reused by a later socket. The host refuses another socket when 1 through 16383 are already in use.

The client sends `0` on [PUSH](./push) until a type 1 message sets its connID, and again after the socket closes. `0` notifies every listener. After the assignment, PUSH carries that varint and the host does not notify that socket.

When the host receives new bags for a user via [PUSH](./push), it sends the bag headers over the WebSocket to that user's other connected clients. This lets those clients skip a PEEK, unless they notice a gap in the sequence numbers they have.

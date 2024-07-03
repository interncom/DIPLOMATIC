# DIPLOMATIC

<video src="https://pub-baf63544dce04e12a9502ae4f58bdc2b.r2.dev/diplomatic-status-demo-720.mov" controls />

## What

DIPLOMATIC is a framework for building single-user apps that work offline and sync multiple devices, all while end-to-end encrypting their data.

It lets developers focus on the unique functionality of their apps without worrying about how to manage data.

## How

DIPLOMATIC is an implementation of the Event Sourcing architecture. It models each change to an application's state as an object, called an *operation*, or *op* for short. Web developers may recognize this pattern from React's [`useReducer`](https://react.dev/learn/extracting-state-logic-into-a-reducer) hook. With DIPLOMATIC, app developers implement a reducer (called an "applier" in DIPLOMATIC) to process these change ops, and DIPLOMATIC handles queueing and relaying them between devices via an untrusted cloud host.

## Core Features

- Works offline.
- Syncs multiple devices.
- End-to-end encrypts data.

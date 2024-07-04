---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "DIPLOMATIC"
  text: "Data sync\nframework"
  tagline: "ALPHA: Technology Preview"
  image:
      src: /count-demo-src.png
      alt: Source code of a demo app using DIPLOMATIC
  actions:
    - theme: brand
      text: Get Started
      link: /docs/#quickstart
    - theme: alt
      text: Demos
      link: /docs/demos/status

features:
  - title: Offline-First
    details: Apps are fully-functional offline. Queues offline changes, then syncs when back online.
    link: docs/arch/system
    icon: "✈️"
  - title: Real-Time Sync
    details: Online devices receive updates immediately via WebSockets.
    link: docs/arch/sync
    icon: "🌐"
  - title: E2E Encrypted
    details: User data never leaves the device unencrypted. Store data on untrusted hosts with confidence.
    link: docs/about/threat
    icon: "🔒"
  - title: Simple
    details: Build an app with all these features in <30 LOC.
    link: docs/demos/count
    icon: "💻"
---

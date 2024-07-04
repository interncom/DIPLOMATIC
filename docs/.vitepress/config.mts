// See https://emersonbottero.github.io/vitepress-plugin-mermaid/guide/getting-started.html.
import { withMermaid } from "vitepress-plugin-mermaid";
// import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default withMermaid({
  title: "DIPLOMATIC",
  description: "Sync framework",
  themeConfig: {
    logo: '/d-logo-sans-crossbar.png',

    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Docs', link: '/docs/' },
      { text: 'Demos', link: '/docs/demos/status' },
    ],

    sidebar: [
      {
        text: 'About',
        items: [
          { text: 'Purpose', link: '/docs/about/purpose' },
          { text: 'Concepts', link: '/docs/about/concepts' },
          { text: 'Threat Model', link: '/docs/about/threat' },
        ],
        collapsed: false,
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System', link: '/docs/arch/system' },
          { text: 'Sync', link: '/docs/arch/sync' },
          { text: 'Authentication', link: '/docs/arch/auth' },
        ],
        collapsed: false,
      },
      {
        text: 'Demos',
        items: [
          { text: 'COUNT', link: '/docs/demos/count' },
          { text: 'STATUS', link: '/docs/demos/status' },
        ],
        collapsed: false,
      },
      {
        text: 'Host',
        items: [
          { text: 'Deno', link: '/docs/host/deno' },
          { text: 'Cloudflare', link: '/docs/host/cloudflare' },
        ],
        collapsed: false,
      },
      {
        text: 'API',
        items: [
          { text: 'Client', link: '/docs/api/client' },
          { text: 'Host', link: '/docs/api/host' },
        ],
        collapsed: false,
      },
      {
        text: 'CLI',
        items: [
          { text: 'diplog', link: '/docs/cli/diplog' },
          { text: 'dipcat', link: '/docs/cli/dipcat' },
        ],
        collapsed: false,
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/interncom/diplomatic' }
    ],

    search: {
      provider: 'local'
    },

    footer: {
      message: 'A product of <a href="https://interncom.org">The Internet Committee</a>.',
      copyright: ''
    }
  },
})

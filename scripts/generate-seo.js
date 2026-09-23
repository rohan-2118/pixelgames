// scripts/generate-seo.js
//
// Emits dist/sitemap.xml and dist/robots.txt after prerender.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const { CATALOG } = await import(pathToFileURL(path.join(ROOT, 'src/registry.js')).href)
const { SITE } = await import(pathToFileURL(path.join(ROOT, 'src/seo/content.js')).href)

const lastmod = new Date().toISOString().slice(0, 10)

function urlEntry(loc, priority, changefreq) {
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
}

function buildSitemap() {
  const entries = [
    urlEntry(`${SITE.domain}/`, '1.0', 'daily'),
    urlEntry(`${SITE.domain}/category/solo`, '0.8', 'weekly'),
    urlEntry(`${SITE.domain}/category/multiplayer`, '0.8', 'weekly'),
    ...CATALOG.map((game) =>
      urlEntry(`${SITE.domain}/games/${game.id}`, '0.9', 'weekly'),
    ),
    urlEntry(`${SITE.domain}/privacy`, '0.3', 'monthly'),
    urlEntry(`${SITE.domain}/terms`, '0.3', 'monthly'),
    urlEntry(`${SITE.domain}/contact`, '0.3', 'monthly'),
  ]

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`
}

function buildRobots() {
  return `User-agent: *
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Googlebot-Image
Allow: /

User-agent: Mediapartners-Google
Allow: /

Sitemap: ${SITE.domain}/sitemap.xml
`
}

fs.mkdirSync(DIST, { recursive: true })
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), buildSitemap(), 'utf8')
fs.writeFileSync(path.join(DIST, 'robots.txt'), buildRobots(), 'utf8')
console.log(`[seo] wrote sitemap.xml (${CATALOG.length + 6} URLs) and robots.txt`)

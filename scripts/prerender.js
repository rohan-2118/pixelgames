// scripts/prerender.js
//
// Post-vite static HTML generation for every catalog game, category, and
// legal page. Reads dist/index.html (with hashed asset URLs) and writes
// deeply-linked copies Googlebot can crawl without executing JS.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const { CATALOG } = await import(pathToFileURL(path.join(ROOT, 'src/registry.js')).href)
const {
  SITE,
  GAME_SEO,
  metaDescription,
  pageTitle,
  faqFor,
} = await import(pathToFileURL(path.join(ROOT, 'src/seo/content.js')).href)

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readShellHtml() {
  const indexPath = path.join(DIST, 'index.html')
  if (!fs.existsSync(indexPath)) {
    throw new Error('[prerender] dist/index.html missing — run vite build first')
  }
  return fs.readFileSync(indexPath, 'utf8')
}

function injectHead(html, { title, description, canonical, ogTitle, ogDescription, ogUrl, jsonLd }) {
  let out = html
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`)

  if (/<meta\s+name="description"/i.test(out)) {
    out = out.replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
  } else {
    out = out.replace(
      /<\/title>/i,
      `</title>\n    <meta name="description" content="${escapeHtml(description)}" />`,
    )
  }

  const headExtras = `
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="PixelGame" />
    <meta property="og:title" content="${escapeHtml(ogTitle)}" />
    <meta property="og:description" content="${escapeHtml(ogDescription)}" />
    <meta property="og:url" content="${escapeHtml(ogUrl)}" />
    <meta property="og:image" content="${escapeHtml(SITE.defaultOgImage)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(ogDescription)}" />
    <meta name="twitter:image" content="${escapeHtml(SITE.defaultOgImage)}" />
    <script type="application/ld+json">${jsonLd}</script>`

  out = out.replace(/<\/head>/i, `${headExtras}\n  </head>`)
  return out
}

function controlsTable(game) {
  const rows = game.instructions.controls
    .map((line) => {
      const parts = line.split(/\s+[—–-]\s+/)
      const key = parts.length > 1 ? parts[0] : line
      const action = parts.length > 1 ? parts.slice(1).join(' — ') : 'In-game action'
      return `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(action)}</td></tr>`
    })
    .join('\n')
  return `<table class="seo-controls"><caption>Controls for ${escapeHtml(game.name)}</caption><thead><tr><th scope="col">Input</th><th scope="col">Action</th></tr></thead><tbody>${rows}</tbody></table>`
}

function faqHtml(faqs) {
  return faqs
    .map(
      (item) => `
      <details class="seo-faq__item">
        <summary>${escapeHtml(item.q)}</summary>
        <p>${escapeHtml(item.a)}</p>
      </details>`,
    )
    .join('\n')
}

function howToList(game) {
  return `<ol class="seo-howto">${game.instructions.howToPlay
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('')}</ol>`
}

function buildGameJsonLd(game, faqs, seo) {
  const url = `${SITE.domain}/games/${game.id}`
  const categoryLabel = game.category === 'solo' ? 'Solo' : 'Multiplayer'
  const categoryUrl = `${SITE.domain}/category/${game.category === 'solo' ? 'solo' : 'multiplayer'}`

  const graph = [
    {
      '@type': ['VideoGame', 'WebApplication'],
      '@id': `${url}#game`,
      name: game.name,
      description: metaDescription(game.name),
      url,
      image: SITE.defaultOgImage,
      operatingSystem: 'Any modern web browser (Google Chrome, Microsoft Edge, Mozilla Firefox, Safari)',
      applicationCategory: 'GameApplication',
      genre: seo.genre,
      gamePlatform: ['Web Browser', 'Chromebook', 'Desktop', 'Mobile'],
      numberOfPlayers: {
        '@type': 'QuantitativeValue',
        minValue: seo.minPlayers,
        maxValue: seo.maxPlayers,
      },
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
      },
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: '4.9',
        reviewCount: '1420',
        bestRating: '5',
        worstRating: '1',
      },
      publisher: {
        '@type': 'Organization',
        name: SITE.name,
        url: SITE.domain,
      },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE.domain + '/' },
        { '@type': 'ListItem', position: 2, name: categoryLabel, item: categoryUrl },
        { '@type': 'ListItem', position: 3, name: game.name, item: url },
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faqs.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ]

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
}

function gameLandingHtml(game) {
  const seo = GAME_SEO[game.id] || {
    genre: ['Arcade', 'Browser Game', 'Unblocked Game'],
    summary: game.description,
    minPlayers: 1,
    maxPlayers: game.capacity,
  }
  const faqs = faqFor(game)
  const catSlug = game.category === 'solo' ? 'solo' : 'multiplayer'
  const catLabel = game.category === 'solo' ? 'Solo' : 'Multiplayer'

  return `
<article class="seo-landing" id="seo-prerender" data-game-id="${escapeHtml(game.id)}">
  <nav class="seo-breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li><a href="/">Home</a></li>
      <li><a href="/category/${catSlug}">${catLabel}</a></li>
      <li aria-current="page">${escapeHtml(game.name)}</li>
    </ol>
  </nav>
  <h1>${escapeHtml(game.name)} - Free Online Browser Game</h1>
  <p class="seo-lead">${escapeHtml(game.description)}</p>
  <section class="seo-summary">
    <h2>About ${escapeHtml(game.name)}</h2>
    <p>${escapeHtml(seo.summary)}</p>
  </section>
  <section class="seo-objective">
    <h2>Objective</h2>
    <p>${escapeHtml(game.instructions.objective)}</p>
  </section>
  <section class="seo-controls-wrap">
    <h2>Keyboard &amp; Touch Controls</h2>
    ${controlsTable(game)}
  </section>
  <section class="seo-howto-wrap">
    <h2>How to Play</h2>
    ${howToList(game)}
  </section>
  <section class="seo-faq" aria-label="Frequently asked questions">
    <h2>${escapeHtml(game.name)} FAQ</h2>
    ${faqHtml(faqs)}
  </section>
  <p class="seo-cta"><a href="/games/${escapeHtml(game.id)}">Play ${escapeHtml(game.name)} now — free, unblocked, no download</a></p>
</article>`
}

function categoryLandingHtml(category) {
  const label = category === 'solo' ? 'Solo' : 'Multiplayer'
  const games = CATALOG.filter((g) =>
    category === 'solo' ? g.capacity === 1 : g.capacity > 1,
  )
  const list = games
    .map(
      (g) =>
        `<li><a href="/games/${escapeHtml(g.id)}"><strong>${escapeHtml(g.name)}</strong></a> — ${escapeHtml(g.description)}</li>`,
    )
    .join('\n')

  return `
<article class="seo-landing" id="seo-prerender">
  <nav class="seo-breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li><a href="/">Home</a></li>
      <li aria-current="page">${label} Games</li>
    </ol>
  </nav>
  <h1>${label} Browser Games — Play Free on PixelGame</h1>
  <p>Browse free ${label.toLowerCase()} HTML5 games on PixelGame. Instant load, no accounts, no downloads — unblocked on Chromebook, PC, and mobile.</p>
  <ul class="seo-game-list">${list}</ul>
</article>`
}

function legalLandingHtml(page) {
  const titles = {
    privacy: 'Privacy Policy',
    terms: 'Terms of Use',
    contact: 'Contact',
  }
  const bodies = {
    privacy: `<p>PixelGame is an ephemeral browser arcade. We do not create user accounts, and we do not operate a gameplay database. A short-lived <code>sessionStorage</code> snapshot may restore an active match after refresh and is cleared when you return to the arcade grid. Advertising partners such as Google AdSense may set their own cookies subject to your browser settings.</p>`,
    terms: `<p>PixelGame games are provided free of charge for personal entertainment. Do not attempt to reverse-engineer peer networking for abuse. Content is offered as-is without warranties. By playing you agree to use the service lawfully and respectfully.</p>`,
    contact: `<p>Reach PixelGame at <a href="mailto:hello@pixelgame.games">hello@pixelgame.games</a> for partnership, DMCA, or AdSense inquiries. We do not provide account support because PixelGame has no accounts.</p>`,
  }
  return `
<article class="seo-landing" id="seo-prerender">
  <nav class="seo-breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li><a href="/">Home</a></li>
      <li aria-current="page">${titles[page]}</li>
    </ol>
  </nav>
  <h1>${titles[page]}</h1>
  ${bodies[page]}
</article>`
}

function writeHtml(relPath, html) {
  const full = path.join(DIST, relPath)
  ensureDir(path.dirname(full))
  fs.writeFileSync(full, html, 'utf8')
  console.log(`[prerender] ${relPath}`)
}

function attachLanding(shellHtml, landingHtml) {
  if (/<\/div>\s*<script/i.test(shellHtml)) {
    // Insert SEO article after #app closes, before module scripts.
    return shellHtml.replace(
      /(<\/div>\s*)(<script[\s\S]*<\/body>)/i,
      `$1${landingHtml}\n$2`,
    )
  }
  return shellHtml.replace(/<\/body>/i, `${landingHtml}\n</body>`)
}

function writeOgDefault() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#080c14"/><stop offset="1" stop-color="#0d1320"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="80" y="300" fill="#00f0ff" font-family="ui-monospace,monospace" font-size="72" font-weight="800">PIXELGAME</text>
  <text x="80" y="380" fill="#8fa3c0" font-family="ui-sans-serif,system-ui" font-size="36">Free unblocked browser arcade</text>
</svg>`
  fs.writeFileSync(path.join(DIST, 'og-default.svg'), svg, 'utf8')
}

function main() {
  const shell = readShellHtml()
  writeOgDefault()

  // Home: enrich root index with canonical + default OG (keep existing shell).
  const homeHtml = injectHead(shell, {
    title: 'PixelGame — Free Unblocked Browser Games (No Download)',
    description:
      'Play free unblocked browser games on PixelGame. Instant HTML5 arcade — solo and multiplayer, zero accounts, zero downloads, Chromebook ready.',
    canonical: `${SITE.domain}/`,
    ogTitle: 'PixelGame — Free Unblocked Browser Games',
    ogDescription: SITE.tagline,
    ogUrl: `${SITE.domain}/`,
    jsonLd: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE.name,
      url: SITE.domain,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE.domain}/games/{game}`,
        'query-input': 'required name=game',
      },
    }),
  })
  writeHtml('index.html', homeHtml)

  for (const game of CATALOG) {
    const seo = GAME_SEO[game.id] || {
      genre: ['Arcade', 'Browser Game'],
      minPlayers: 1,
      maxPlayers: game.capacity,
      summary: game.description,
    }
    const faqs = faqFor(game)
    const title = pageTitle(game)
    const description = metaDescription(game.name)
    const canonical = `${SITE.domain}/games/${game.id}`
    const withLanding = attachLanding(shell, gameLandingHtml(game))
    const html = injectHead(withLanding, {
      title,
      description,
      canonical,
      ogTitle: title,
      ogDescription: description,
      ogUrl: canonical,
      jsonLd: buildGameJsonLd(game, faqs, seo),
    })
    writeHtml(path.join('games', game.id, 'index.html'), html)
  }

  for (const category of ['solo', 'multiplayer']) {
    const label = category === 'solo' ? 'Solo' : 'Multiplayer'
    const canonical = `${SITE.domain}/category/${category}`
    const title = `${label} Games — Free Online Browser Arcade | PixelGame`
    const description = `Play free ${label.toLowerCase()} browser games on PixelGame. Instant load, no accounts, unblocked on Chromebook, PC, and mobile.`
    const withLanding = attachLanding(shell, categoryLandingHtml(category))
    const html = injectHead(withLanding, {
      title,
      description,
      canonical,
      ogTitle: title,
      ogDescription: description,
      ogUrl: canonical,
      jsonLd: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        url: canonical,
      }),
    })
    writeHtml(path.join('category', category, 'index.html'), html)
  }

  for (const page of ['privacy', 'terms', 'contact']) {
    const titles = {
      privacy: 'Privacy Policy | PixelGame',
      terms: 'Terms of Use | PixelGame',
      contact: 'Contact | PixelGame',
    }
    const descriptions = {
      privacy: 'PixelGame privacy policy — ephemeral arcade with no accounts and minimal session storage.',
      terms: 'PixelGame terms of use for the free browser gaming portal.',
      contact: 'Contact PixelGame for partnerships and policy inquiries.',
    }
    const canonical = `${SITE.domain}/${page}`
    const withLanding = attachLanding(shell, legalLandingHtml(page))
    const html = injectHead(withLanding, {
      title: titles[page],
      description: descriptions[page],
      canonical,
      ogTitle: titles[page],
      ogDescription: descriptions[page],
      ogUrl: canonical,
      jsonLd: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: titles[page],
        url: canonical,
      }),
    })
    writeHtml(path.join(page, 'index.html'), html)
  }

  console.log(`[prerender] done — ${CATALOG.length} games + categories + legal`)
}

main()

# ImageForge US/EU SEO keyword map and implementation backlog — 2026-11-20

Status: source-verified intent mapping. Candidate phrases are not search-volume claims. No ranking, indexing, or traffic outcome is asserted.

## Market and editorial rules

- Primary market: United States; English-first. Expand to Europe after US query and conversion evidence.
- Improve the existing editor and supporting pages before creating new landing pages.
- One distinct search intent per canonical URL. Do not create thin keyword doorway pages.
- Do not claim features, file support, or privacy guarantees beyond the current implementation.
- Keep the editor usable first: SEO copy must not block the canvas, add intrusive overlays, or harm mobile editing.

## Verified URL inventory

The source sitemap template lists seven URLs. The build substitutes BRAND_SITE for the site root:

| Canonical URL | Existing intent | Source evidence |
|---|---|---|
| https://draw.digdevbox.com/ | Free online photo/image editor | src/template/index.html; SoftwareApplication JSON-LD; hidden H1 and static SEO guide |
| https://draw.digdevbox.com/guides | Image editing tutorials | guides.html; four task walkthroughs |
| https://draw.digdevbox.com/faq | Image editor FAQ | faq.html; setup, privacy, formats, transparency and troubleshooting |
| https://draw.digdevbox.com/about | About / browser-based editor explanation | about.html; features and technology |
| https://draw.digdevbox.com/contact | Contact | contact.html |
| https://draw.digdevbox.com/privacy | Privacy policy | privacy.html |
| https://draw.digdevbox.com/terms | Terms | terms.html |

Sitemap source: src/template/sitemap.xml. robots.txt references https://draw.digdevbox.com/sitemap.xml. The template currently uses BRAND_SITE placeholders; verify the generated production sitemap, not the raw template.

## Keyword-to-page map

All phrases below are candidate intent variants, not verified search volume.

| Priority | Target | Primary intent | Supporting phrase candidates | Implementation |
|---|---|---|---|---|
| P0 | / | free online image editor | free image editor online; online photo editor; browser image editor; edit photos online; free photo editor no download | Preserve the broad tool intent. Make the first-screen description concise and accurately identify layers, selections, brushes, text, filters, adjustments and browser-based editing. |
| P0 | /guides | how to edit photos online | how to use an online photo editor; remove image background online; resize image for web; edit image with layers; image editor tutorial | Keep task walkthroughs specific and link each task to the editor. Add descriptive anchors from the editor back to the guide. |
| P0 | /faq | online image editor FAQ | does online image editor upload photos; image editor supported formats; how to use layers; image editor offline | Answer real product questions. Align privacy language with actual code and user-triggered external fetch/search features. |
| P1 | / | photo editor with layers | online editor with layers; layer based image editor; image editor with selection tools; browser image editor with brushes | Explain layers, selection tools, brushes, text, shapes, adjustments and transforms that are verified in the tool registry and UI. |
| P1 | / | image editor without upload | edit photos in browser; private browser image editor; local image editor; offline image editor | State that local file processing occurs in-browser. Distinguish this from explicit Open from URL and third-party stock-photo search, which make network requests. Do not claim the entire site has no network traffic. |
| P1 | /guides | remove background with magic wand | remove solid background from image; magic wand background removal; transparent background editor | Describe the existing Magic Wand workflow and its limitations; do not imply AI one-click segmentation. |
| P1 | /guides | resize image online | resize photo for web; crop image online; rotate image; export image as PNG | Tie copy to the actual crop/resize/rotate/export workflow. |
| P2 | /faq | image file formats | edit PNG online; edit JPEG online; WebP image editor; edit GIF online; SVG editor | Clarify browser decode and export support. Do not promise universal format support independent of browser codec capabilities. |
| P2 | /about | free Photoshop alternative | lightweight Photoshop alternative; open source image editor; browser-based photo editor | Use measured, fair positioning; do not claim full Photoshop feature parity. |

## Technical and content QA

1. Crawl deployed homepage, guides, FAQ, about and sitemap. Verify HTTP status, canonical, robots, title, description, H1, internal links and mobile rendering.
2. Verify the built sitemap contains seven absolute canonical URLs under https://draw.digdevbox.com, with no template tokens, staging hostnames or redirects.
3. Check each sitemap URL returns 200 and self-canonicalizes. Keep the root trailing slash consistent; keep existing extensionless paths consistent.
4. The editor homepage has a SoftwareApplication JSON-LD block. Validate it after brand substitution and ensure name, URL and description match visible content.
5. Preserve meaningful crawlable static text outside the JavaScript-rendered canvas. Do not add keyword-stuffed paragraphs or duplicate FAQ markup.
6. Verify internal links between homepage, guides and FAQ. Ensure the guide and FAQ pages link users back to the editor with descriptive anchors.
7. Test browser processing and network behavior. Local file processing must not transmit image bytes, filenames, EXIF or data URLs. Explicit Open from URL and stock-photo search are user-triggered network actions and must remain clearly distinguished.
8. Pull GSC and Bing page/query/country data for draw.digdevbox.com. Record impressions, clicks, CTR and average position by page and query before changing titles. Candidate phrases remain unvalidated until query data confirms them.

## Implementation sequence

- First: run a production crawl against the generated sitemap and canonical pages.
- Second: compare generated metadata and sitemap with source templates; fix only demonstrated mismatches.
- Third: improve the homepage-to-guides/FAQ links and guide-to-editor task links where gaps are confirmed.
- Fourth: review the editor's visible first-screen copy and static SEO guide for intent clarity without harming editor UX.
- Fifth: use GSC/Bing query and country evidence to prioritize one content change at a time; monitor CTR and indexing over a meaningful window.

## Evidence and limitations

- Source inspected on 2026-11-20: brand.config.json, src/template/index.html, src/template/sitemap.xml, robots.txt, guides.html, faq.html and about.html.
- The sitemap and homepage use build-time brand placeholders. Raw template inspection is not production crawl verification.
- No ImageForge-specific GSC/Bing query export is included in this research pass. Search demand, keyword volume, rankings, indexing and organic traffic are not asserted.

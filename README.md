# singchinese
# singchinese.online

## Shared lyric translation cache

LRCLIB songs use Chrome's browser Translator API only on a cache miss. Successful
English translations are written to the Cloudflare Pages Function at
`/api/translation-cache`, backed by a KV namespace binding named
`LYRIC_TRANSLATION_CACHE`.

Cloudflare Pages setup:

1. Create a KV namespace for lyric translations.
2. In the Pages project, add a KV binding named `LYRIC_TRANSLATION_CACHE` for
   Production and Preview.
3. Redeploy the site.

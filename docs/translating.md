# Translating Artel

Artel ships with English (`en`), Russian (`ru`) and Chinese (`zh`). Every
user-visible string in the panel, the run feed, the auto-queue journal, the
Factory board and API errors comes from a catalogue file — adding a language
needs no code change.

## Catalogue files

One file per language in [`locale/`](../locale):

```json
{
  "meta": {
    "title": "Artel",
    "description": "Multi-agent workspace …",
    "detail": "docs/guide.md",
    "nativeName": "English",
    "dir": "ltr"
  },
  "strings": {
    "surface.title": "Artel",
    "chats.tasks.one": "{n} Artel task"
  }
}
```

- The file name is the BCP-47 tag (`en`, `ru`, `zh`, `de`, `pt-BR`).
- `meta` is read by the DSH plugin manager: `title`, `description` and
  `detail` (the guide path) name the plugin card, `nativeName` is what the
  language switch shows, `dir` is `ltr` (reserved for right-to-left support).
- `strings` is a flat map of dotted lower-case keys. `en` is the source of
  truth: add the key there first.

## Keys and placeholders

Namespaces: `surface.*`, `launcher.*`, `chats.*`, `queue.*`, `factory.*`,
`feed.*`, `error.*`, plus the existing UI namespaces.

- Never translate a placeholder name: `{project}`, `{title}`, `{n}` must
  appear exactly as in English.
- Keep punctuation that carries meaning (quotes around titles, the trailing
  period) consistent with the English source.
- Do not translate: mode names (Solo, Swarm, Conductor, Fusion, Orchestrator),
  status codes, error codes, file paths, command names, branches, PR/commit
  text and agent output.

## Plurals

Plural keys use `Intl.PluralRules` categories as suffixes: `.zero`, `.one`,
`.two`, `.few`, `.many`, `.other`. Each language must define exactly the
categories its rules need:

- English: `one`, `other`
- Russian: `one`, `few`, `many`, `other`
- Chinese: `other`

The base key (for example `chats.tasks`) is never stored; only its category
keys are.

## Add a language

1. Copy `locale/en.json` to `locale/<tag>.json`.
2. Translate every value in `strings`; set `meta.nativeName` (and `meta.title`
   / `meta.description` / `meta.detail` if the guide is translated).
3. Run `node tools/build-locales.mjs` — it compiles the catalogues into the
   generated block in `lib/client.js`.
4. Run `npm test`. The locale test fails on a missing key, an unexpected
   plural category, a placeholder mismatch or a stale generated block.
5. Add the README and guide to the language navigation if you translated them.

The generated block is never edited by hand. `npm test` runs
`node tools/build-locales.mjs --check` and fails when it is stale.

## What lives where

- UI strings: `locale/*.json` → generated `DICTIONARIES` in `lib/client.js`.
- Host events: the Host emits `{ key, params, text }`; the client resolves
  `key` and falls back to the English `text` for records written by older
  versions.
- The active language is stored per profile in `<stateDir>/settings.json`
  (`null` follows the DSH language) and served by
  `GET/POST /api/dsh-artel/settings`.

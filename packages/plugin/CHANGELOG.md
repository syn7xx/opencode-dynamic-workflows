# Changelog

## [0.6.2](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.6.1...v0.6.2) (2026-11-02)


### Bug fixes

* **rpc:** route run-scoped calls to the location that owns the Run ([2b8c70d](https://github.com/syn7xx/opencode-dynamic-workflows/commit/2b8c70dafd05a2848407cff4aabf9a41c38069d6))

## [0.6.1](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.6.0...v0.6.1) (2026-11-02)


### Bug fixes

* **gui:** make the Run view's phase row filter Units ([f3a0c21](https://github.com/syn7xx/opencode-dynamic-workflows/commit/f3a0c21344d542562dac1fbc56fabf211c37bff8))
* **gui:** translate the 'of' in the Units and question progress ([891e2e3](https://github.com/syn7xx/opencode-dynamic-workflows/commit/891e2e3db6bcf125981c51664d3de6aa92e6f2a4))

## [0.6.0](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.5.0...v0.6.0) (2026-11-02)


### Features

* **gui:** add a Russian catalog, English stays the fallback ([f219038](https://github.com/syn7xx/opencode-dynamic-workflows/commit/f2190383224d5e17669860ecd1c964e01139c349))
* **gui:** add eleven more UI catalogs (de, es, fr, it, nl, br, tr, ja, ko, uk, pl) ([d7ecff3](https://github.com/syn7xx/opencode-dynamic-workflows/commit/d7ecff3e8f2ff6f7efceff423f455720c2df761e))
* **gui:** add Simplified and Traditional Chinese catalogs ([4407597](https://github.com/syn7xx/opencode-dynamic-workflows/commit/4407597b5012d3ba38104796d80e20f43a1419f1))
* **gui:** add the desktop GUI plugin (side panel, strip, badge) ([5bda84f](https://github.com/syn7xx/opencode-dynamic-workflows/commit/5bda84fb7a60ee9786678f7952853743448e23a8))
* **gui:** add the desktop GUI plugin for Workflows ([7d3f3ec](https://github.com/syn7xx/opencode-dynamic-workflows/commit/7d3f3ec384bc37dc226ba25b2c8758dc9e9f5567))
* **gui:** jump from the waiting badge to the Run it stands for ([daa32dc](https://github.com/syn7xx/opencode-dynamic-workflows/commit/daa32dcc63f8bfe83c230676cf8ad0d710f8c9c6))
* **gui:** show a tooltip on the "Open in browser" icon ([9a80fc9](https://github.com/syn7xx/opencode-dynamic-workflows/commit/9a80fc96ea52f9dc57d996e7fb6d0ee0823663d5))
* **gui:** show token usage in the Unit list ([e0d55f9](https://github.com/syn7xx/opencode-dynamic-workflows/commit/e0d55f97709f9ec68634ff6b5f9dfaeb3c41fd1d))
* make Workflows breadcrumbs clickable to navigate back ([b1ffb17](https://github.com/syn7xx/opencode-dynamic-workflows/commit/b1ffb17d906a54e0f2a9c0f84fdb6faa55e67671))

## [0.5.0](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.4.1...v0.5.0) (2026-10-30)


### Features

* **workflow:** inherit the caller's model and make effort work alone ([521f068](https://github.com/syn7xx/opencode-dynamic-workflows/commit/521f0684bac1a3b47bb0d4d5c1982dda4be1c18a))
* **workflow:** inherit the caller's model and make effort work alone ([6849199](https://github.com/syn7xx/opencode-dynamic-workflows/commit/68491998f4d1776eaf0697a17a93aaa7af3bcc23))

## [0.4.1](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.4.0...v0.4.1) (2026-10-29)


### Bug fixes

* **web:** multiplex Gateway events onto one stream ([f06af9a](https://github.com/syn7xx/opencode-dynamic-workflows/commit/f06af9abcf0489817e07614300662d73903e4c30))
* **web:** stop the Gateway connection from hanging, and multiplex events ([d685634](https://github.com/syn7xx/opencode-dynamic-workflows/commit/d68563420dd756066a827a104940ebed3781c329))

## [0.4.0](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.3.0...v0.4.0) (2026-10-29)


### Features

* **workflow:** read a replayed Unit's tool calls from its original session ([d910a2c](https://github.com/syn7xx/opencode-dynamic-workflows/commit/d910a2c7f6a985ab66b36af795b6f04d57f9a357))
* **workflow:** read a replayed Unit's tool calls from its original session ([4565a1c](https://github.com/syn7xx/opencode-dynamic-workflows/commit/4565a1c66c18af03526a0319d0c45e6a01bf92d2)), closes [#15](https://github.com/syn7xx/opencode-dynamic-workflows/issues/15)


### Bug fixes

* **journal:** read a process's start time under a non-English locale ([5b688c1](https://github.com/syn7xx/opencode-dynamic-workflows/commit/5b688c1e5ad2db48899248a8c6bfbec647d7e48f))

## [0.3.0](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.2.2...v0.3.0) (2026-10-28)


### Features

* **workflow:** expose a Unit's tool calls as agent() receipts ([8c6085d](https://github.com/syn7xx/opencode-dynamic-workflows/commit/8c6085d6c3ad0a2a2f527237c06e5d84d193c8f9))
* **workflow:** expose a Unit's tool calls as agent() receipts ([f141d00](https://github.com/syn7xx/opencode-dynamic-workflows/commit/f141d00715fc0b654588dec57f66c0777b12bbdc))


### Bug fixes

* **registry:** discover only files that export a Workflow entrypoint ([860b1e3](https://github.com/syn7xx/opencode-dynamic-workflows/commit/860b1e31357a99c6f3e3257c10fb300a35a16d9d))
* resume decomposed Workflows, stop discovering helper modules, key the loader cache on the graph ([6f0b580](https://github.com/syn7xx/opencode-dynamic-workflows/commit/6f0b580cee358e25c0460abfbfadb66771baead1))
* **resume:** journal the bundled module so a decomposed Run resumes ([77cb943](https://github.com/syn7xx/opencode-dynamic-workflows/commit/77cb943147a862e52748b2a9d680c97463da2d86))
* **resume:** match the bundled entry by its real path ([70fddfa](https://github.com/syn7xx/opencode-dynamic-workflows/commit/70fddfabd5fd526d080ea70ffc96eab42568517a))

## [0.2.2](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.2.1...v0.2.2) (2026-10-25)


### Bug fixes

* give the TUI syntax style its native resource owner ([695aaf1](https://github.com/syn7xx/opencode-dynamic-workflows/commit/695aaf159456d31ecd9fefe501978ec81ca95288))
* keep the native question tool working in ordinary sessions ([#1](https://github.com/syn7xx/opencode-dynamic-workflows/issues/1)) ([4b73a2a](https://github.com/syn7xx/opencode-dynamic-workflows/commit/4b73a2a7eade1f921921c783b06316d0d02fe3ab))
* stop forcing provenance on local publishes ([4bcc7e3](https://github.com/syn7xx/opencode-dynamic-workflows/commit/4bcc7e3c75485b095d92cfe643bad8bec5b0c1f6))

## [0.2.1](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.2.0...v0.2.1) (2026-10-25)


### Miscellaneous

* drop the stale `docs/superpowers/` entry from `.gitignore`

## [0.2.0](https://github.com/syn7xx/opencode-dynamic-workflows/compare/v0.1.0...v0.2.0) (2026-10-20)


### Bug fixes

* **tui:** give the syntax style its native resource owner ([695aaf1](https://github.com/syn7xx/opencode-dynamic-workflows/commit/695aaf159456d31ecd9fefe501978ec81ca95288))

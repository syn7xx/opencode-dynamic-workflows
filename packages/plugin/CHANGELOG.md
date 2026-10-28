# Changelog

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

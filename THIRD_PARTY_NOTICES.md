# Third-party notices

The page ships two open-source libraries in `lib/` and six open-source typefaces in `fonts/`. They are kept
byte for byte as published on npm; the SHA-256 of each file is below, so a copy can be checked against the
release it came from.

| File | Library | Version | License | SHA-256 |
|---|---|---|---|---|
| `lib/pdf.min.js` | PDF.js (`pdfjs-dist`, `build/pdf.min.js`) | 3.11.174 | Apache-2.0 | `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946` |
| `lib/pdf.worker.min.js` | PDF.js (`pdfjs-dist`, `build/pdf.worker.min.js`) | 3.11.174 | Apache-2.0 | `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b` |
| `lib/exceljs.min.js` | ExcelJS (`exceljs`, `dist/exceljs.min.js`, build dated 19-10-2023) | 4.4.0 | MIT | `7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9` |

To check them:

```
sha256sum lib/*.min.js fonts/*.woff2
```

## PDF.js

Copyright 2023 Mozilla Foundation. Licensed under the Apache License, Version 2.0. Source:
https://github.com/mozilla/pdf.js. The full license text is in `LICENSES/pdf.js-Apache-2.0.txt`, and the
license notice is kept at the top of both files.

## Fonts

The page uses the same typefaces as https://maidenpeter.github.io. Because the page loads nothing from any other
origin, the Latin subsets are copied into `fonts/` from the Fontsource npm packages (version 5.3.0 of each),
byte for byte. All are licensed under the SIL Open Font License 1.1; each license, with its copyright line, is in
`LICENSES/font-<name>-OFL.txt`.

| File | Typeface | Package | SHA-256 |
|---|---|---|---|
| `fonts/eb-garamond-latin-400-normal.woff2` | EB Garamond 400 | `@fontsource/eb-garamond` | `912929dba0faab5e151849ea5e988adba3080ad6d2bcc4dbff27aa427896498d` |
| `fonts/eb-garamond-latin-500-normal.woff2` | EB Garamond 500 | `@fontsource/eb-garamond` | `7b252686ba2797f0a376a4ce7e56534dfc2007fba8b50546bb11b24f9279b5c7` |
| `fonts/ibm-plex-sans-condensed-latin-400-normal.woff2` | IBM Plex Sans Condensed 400 | `@fontsource/ibm-plex-sans-condensed` | `456bf5cda9c0b1f1ead43f01b80df5ba5af7cb41d7cbc0543091537c39fb4c89` |
| `fonts/ibm-plex-sans-condensed-latin-500-normal.woff2` | IBM Plex Sans Condensed 500 | `@fontsource/ibm-plex-sans-condensed` | `e3b4fd97fd20bc70fda66d8d5f0745d8d6958068a024cb4724bbc1ffb6cbc183` |
| `fonts/ibm-plex-sans-condensed-latin-600-normal.woff2` | IBM Plex Sans Condensed 600 | `@fontsource/ibm-plex-sans-condensed` | `3d72a0923c5830358b0a8e25b258aecadbecbf542b6ee9a25f387803e37d56b9` |
| `fonts/im-fell-english-latin-400-normal.woff2` | IM Fell English 400 | `@fontsource/im-fell-english` | `248300df1647bec49155a5cada1d65f719ae633ef48564d1f19b135a8a5b7f5f` |
| `fonts/im-fell-english-sc-latin-400-normal.woff2` | IM Fell English SC 400 | `@fontsource/im-fell-english-sc` | `f0f85c4edd2c3dc659db649e9fd0258951445d2fa0735eb43b44a1052ed3d2f5` |
| `fonts/old-standard-tt-latin-400-normal.woff2` | Old Standard TT 400 | `@fontsource/old-standard-tt` | `52d24e5960257c67b198c2e9098fc9663dbced0e0e2fc3f305987cdfa350caaf` |
| `fonts/pinyon-script-latin-400-normal.woff2` | Pinyon Script 400 | `@fontsource/pinyon-script` | `3e1f69a201572cad4aabea7ccf720f093a7dbc005380b2a1b89e0b94476d3e42` |

## ExcelJS

Copyright (c) 2014-2019 Guyon Roche. Licensed under the MIT License. Source: https://github.com/exceljs/exceljs.
The full license text is in `LICENSES/ExcelJS-MIT.txt`. The ExcelJS build bundles further open-source
packages (among them JSZip, under MIT or GPLv3 at the user's choice, used here under MIT); their notices are
kept inside `lib/exceljs.min.js` as published.

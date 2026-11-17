# Third-party notices

The page ships two open-source libraries in `lib/`. They are kept byte for byte as published on npm; the
SHA-256 of each file is below, so a copy can be checked against the release it came from.

| File | Library | Version | License | SHA-256 |
|---|---|---|---|---|
| `lib/pdf.min.js` | PDF.js (`pdfjs-dist`, `build/pdf.min.js`) | 3.11.174 | Apache-2.0 | `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946` |
| `lib/pdf.worker.min.js` | PDF.js (`pdfjs-dist`, `build/pdf.worker.min.js`) | 3.11.174 | Apache-2.0 | `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b` |
| `lib/exceljs.min.js` | ExcelJS (`exceljs`, `dist/exceljs.min.js`, build dated 19-10-2023) | 4.4.0 | MIT | `7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9` |

To check them:

```
sha256sum lib/*.min.js
```

## PDF.js

Copyright 2023 Mozilla Foundation. Licensed under the Apache License, Version 2.0. Source:
https://github.com/mozilla/pdf.js. The full license text is in `LICENSES/pdf.js-Apache-2.0.txt`, and the
license notice is kept at the top of both files.

## ExcelJS

Copyright (c) 2014-2019 Guyon Roche. Licensed under the MIT License. Source: https://github.com/exceljs/exceljs.
The full license text is in `LICENSES/ExcelJS-MIT.txt`. The ExcelJS build bundles further open-source
packages (among them JSZip, under MIT or GPLv3 at the user's choice, used here under MIT); their notices are
kept inside `lib/exceljs.min.js` as published.

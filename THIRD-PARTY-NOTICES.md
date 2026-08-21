# Third-party notices

VanillaShot is released under the MIT licence; see [LICENSE](LICENSE).

This file lists the third-party components redistributed inside the shipped
application bundle, together with the licence each one is used under. It
covers the JavaScript and WebAssembly that Vite bundles into `dist/`, the
files vendored under `public/`, and the Rust crates linked into the macOS
binary. Build-only and development-only tooling (Vite, ESLint, TypeScript,
the Tauri CLI) is not redistributed and is not listed here.

Versions are those resolved by `package-lock.json` and
`src-tauri/Cargo.lock` at the time of writing. The Rust set is the normal
(non-build, non-dev) dependency tree for `aarch64-apple-darwin`, which is
what is linked into the shipped binary.

## Copyleft summary

No GPL, AGPL, or LGPL-only component is redistributed. Nothing found blocks
distribution of VanillaShot under the MIT licence.

Five MPL-2.0 crates are linked into the macOS binary:

| Crate | Version | Reached via | Upstream |
| --- | --- | --- | --- |
| `option-ext` | 0.2.0 | `dirs-sys` -> `dirs` -> `tauri`, `wry` | https://github.com/soc/option-ext |
| `cssparser` | 0.29.6 | `selectors` -> `kuchikiki` -> `tauri-utils` -> `tauri` | https://github.com/servo/rust-cssparser |
| `cssparser-macros` | 0.6.1 | `cssparser` | https://github.com/servo/rust-cssparser |
| `selectors` | 0.24.0 | `kuchikiki` -> `tauri-utils` -> `tauri` | https://github.com/servo/servo |
| `dtoa-short` | 0.3.5 | `cssparser` | https://github.com/upsuper/dtoa-short |

MPL-2.0 is file-level (weak) copyleft. Section 3.3 of the licence permits
the Larger Work — VanillaShot as a whole — to be distributed under other
terms, including MIT, provided the MPL-covered files themselves stay under
MPL-2.0 and recipients are told where to obtain their source. None of these
five crates has been modified by this project; unmodified source for each is
available at the upstream URL above and on crates.io. The full licence text
is at https://mozilla.org/MPL/2.0/.

So: an MPL-2.0 component is present, it is named above, and it does not
conflict with MIT redistribution.

## Apache-2.0 components

The components in this section are redistributed under the Apache License,
Version 2.0. The full text of that licence appears once, near the end of
this file, and applies to every component listed here.

### Bundled into `dist/` and `public/`

| Component | Version | Licence | Upstream |
| --- | --- | --- | --- |
| tesseract.js | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| tesseract.js-core | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js-core |
| Tesseract OCR engine (compiled into the tesseract.js-core WASM) | 5.x | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |
| `eng.traineddata` OCR model | 4.00 | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |
| ZXing-C++ (compiled into `zxing_reader.wasm`) | pinned by zxing-wasm 3.1.3 | Apache-2.0 | https://github.com/zxing-cpp/zxing-cpp |
| idb-keyval | 6.2.2 | Apache-2.0 | https://github.com/jakearchibald/idb-keyval |
| wasm-feature-detect | 1.8.0 | Apache-2.0 | https://github.com/GoogleChromeLabs/wasm-feature-detect |

`scripts/vendor-tesseract.mjs` copies four files out of `node_modules` into
`public/tesseract/` so that OCR works offline and does not call
cdn.jsdelivr.net on every cold start:

- `worker.min.js` (from tesseract.js)
- `tesseract-core-lstm.wasm.js` (from tesseract.js-core)
- `tesseract-core-simd-lstm.wasm.js` (from tesseract.js-core)
- `tesseract-core-relaxedsimd-lstm.wasm.js` (from tesseract.js-core)

Only the LSTM cores are copied, because `createWorker()` runs with the
default OEM (`LSTM_ONLY`).

`worker.min.js` is a bundle and carries its own notices for code it
embeds: `buffer` (MIT, Feross Aboukhadijeh), `ieee754` (BSD-3-Clause,
Feross Aboukhadijeh), `regenerator-runtime` (MIT, Facebook), and `zlib.js`
(MIT, imaya).

`zxing-wasm` is imported as `zxing-wasm/reader`, and the reader WASM binary
is bundled locally via `import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'`.
The zxing-wasm wrapper itself is MIT (listed further down); the decoding
engine compiled into the binary is ZXing-C++ under Apache-2.0. The `zint`
writer library (BSD-3-Clause) is part of the zxing-wasm writer build only
and is not present in the reader binary this app ships.

### Rust crates

| Crate | Version | Licence | Upstream |
| --- | --- | --- | --- |
| `tao` | 0.34.6 | Apache-2.0 | https://github.com/tauri-apps/tao |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |

`tao` is the only crate in the shipped Rust tree offered under Apache-2.0
alone. `dpi` is dual-conditioned rather than dual-optioned: both licences
apply.

Tauri itself, `wry`, `muda`, `tray-icon` and the Tauri plugins are offered
as "Apache-2.0 OR MIT". They are taken here under MIT and listed in the
MIT/ISC table below.

## OCR language model

`public/tessdata/eng.traineddata.gz` is a gzipped Tesseract English
language model. It is the only large data file this project vendors, and it
is copied into `dist/tessdata/` at build time and loaded by tesseract.js at
runtime with `langPath` pointing at the app's own origin, so OCR never
fetches a model over the network.

- File: `public/tessdata/eng.traineddata.gz`
- Compressed size: 10,923,060 bytes
- Uncompressed size: 23,466,654 bytes (24 tables)
- SHA-256 of the gzipped file: `ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468`
- Origin: the `eng.traineddata` model from the `tesseract-ocr/tessdata`
  repository (the combined legacy + LSTM 4.00 model), gzipped without
  modification
- Upstream: https://github.com/tesseract-ocr/tessdata
- Licence: Apache-2.0

The traineddata files in `tesseract-ocr/tessdata` are distributed under the
Apache License, Version 2.0, the same licence as the Tesseract engine. The
full text is reproduced near the end of this file.

## MPL-2.0 components

See the copyleft summary at the top of this file for the full list, the
dependency paths, and the obligations. The licence text is not reproduced
here; it is available at https://mozilla.org/MPL/2.0/, and unmodified
source for each crate is available from its upstream repository and from
crates.io.

## Unicode-3.0 components

The ICU4X crates below are linked into the macOS binary, reached through
`idna` and `url` in the Tauri dependency tree. All are published by the
Unicode Consortium at https://github.com/unicode-org/icu4x.

`icu_collections` 2.1.1, `icu_locale_core` 2.1.1, `icu_normalizer` 2.1.1,
`icu_normalizer_data` 2.1.1, `icu_properties` 2.1.2, `icu_properties_data`
2.1.2, `icu_provider` 2.1.1, `litemap` 0.8.1, `potential_utf` 0.1.4,
`tinystr` 0.8.2, `writeable` 0.6.2, `yoke` 0.8.1, `yoke-derive` 0.8.1,
`zerofrom` 0.1.6, `zerofrom-derive` 0.1.6, `zerotrie` 0.2.3, `zerovec`
0.11.5, `zerovec-derive` 0.11.2.

The Unicode Licence V3 text is reproduced near the end of this file.

## BSD-licensed components

| Component | Version | Licence | Upstream |
| --- | --- | --- | --- |
| `brotli` | 8.0.2 | BSD-3-Clause AND MIT | https://github.com/dropbox/rust-brotli |
| `brotli-decompressor` | 5.0.0 | BSD-3-Clause OR MIT | https://github.com/dropbox/rust-brotli-decompressor |
| `alloc-no-stdlib` | 2.0.4 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `alloc-stdlib` | 0.2.2 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `ieee754` (embedded in `public/tesseract/worker.min.js`) | 1.2.1 | BSD-3-Clause | https://github.com/feross/ieee754 |

`moxcms` 0.7.11 and `pxfm` 0.1.28 offer "BSD-3-Clause OR Apache-2.0" and
`zerocopy` / `zerocopy-derive` 0.8.40 offer "BSD-2-Clause OR Apache-2.0 OR
MIT"; those are taken under Apache-2.0 and MIT respectively.

The BSD-3-Clause text is reproduced near the end of this file.

## Public domain components

| Component | Version | Status | Upstream |
| --- | --- | --- | --- |
| SQLite (amalgamation compiled by `libsqlite3-sys`) | bundled by `rusqlite` 0.32.1 | Public domain | https://www.sqlite.org/copyright.html |

`rusqlite` is used with its `bundled` feature, so the SQLite amalgamation is
compiled into the binary rather than linked against a system library. SQLite
itself is dedicated to the public domain and requires no attribution; it is
listed here for completeness.

## MIT and ISC components

Their notice requirement is satisfied by naming them together with the
standard permission notice. One representative MIT text and the ISC text are
reproduced near the end of this file; each project's own copyright line is
in its upstream repository.

### JavaScript, bundled into `dist/`

| Component | Version | Licence | Upstream |
| --- | --- | --- | --- |
| react | 19.2.4 | MIT | https://github.com/facebook/react |
| react-dom | 19.2.4 | MIT | https://github.com/facebook/react |
| scheduler | 0.27.0 | MIT | https://github.com/facebook/react |
| lucide-react | 0.577.0 | ISC | https://github.com/lucide-icons/lucide |
| zxing-wasm | 3.1.3 | MIT | https://github.com/Sec-ant/zxing-wasm |
| @tauri-apps/api | 2.10.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-global-shortcut | 2.3.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| bmp-js | 0.1.0 | MIT | https://github.com/shaozilee/bmp-js |
| is-url | 1.2.4 | MIT | https://github.com/segmentio/is-url |
| zlibjs | 0.3.1 | MIT | https://github.com/imaya/zlib.js |
| regenerator-runtime | 0.13.11 | MIT | https://github.com/facebook/regenerator |
| node-fetch | 2.7.0 | MIT | https://github.com/node-fetch/node-fetch |
| buffer (embedded in `worker.min.js`) | 6.x | MIT | https://github.com/feross/buffer |

`bmp-js`, `is-url`, `zlibjs`, `regenerator-runtime` and `node-fetch` are
dependencies of tesseract.js. `node-fetch` is only reached on the Node code
path and is inert in the browser build.

### Rust, linked into the macOS binary

Direct dependencies declared in `src-tauri/Cargo.toml`:

| Crate | Version | Licence | Upstream |
| --- | --- | --- | --- |
| `tauri` | 2.10.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin-log` | 2.8.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-deep-link` | 2.4.9 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-global-shortcut` | 2.3.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `arboard` | 3.6.1 | MIT OR Apache-2.0 | https://github.com/1Password/arboard |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `chrono` | 0.4.44 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| `image` | 0.25.9 | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| `log` | 0.4.29 | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| `rusqlite` | 0.32.1 | MIT | https://github.com/rusqlite/rusqlite |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | 1.0.149 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `tokio` | 1.50.0 | MIT | https://github.com/tokio-rs/tokio |

Significant transitive crates in the same family:

| Crate | Version | Licence | Upstream |
| --- | --- | --- | --- |
| `wry` | 0.54.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/wry |
| `tauri-runtime-wry` | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-utils` | 2.8.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `muda` | 0.17.1 | Apache-2.0 OR MIT | https://github.com/amrbashir/muda |
| `tray-icon` | 0.21.3 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tray-icon |
| `kuchikiki` | 0.8.8-speedreader | MIT | https://github.com/brave/kuchikiki |
| `libsqlite3-sys` | 0.30.1 | MIT | https://github.com/rusqlite/rusqlite |
| `objc2` and the `objc2-*` framework crates | 0.6.x / 0.3.x | MIT, or Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| `dirs` | 6.0.0 | MIT OR Apache-2.0 | https://github.com/soc/dirs-rs |
| `dirs-sys` | 0.5.0 | MIT OR Apache-2.0 | https://github.com/dirs-dev/dirs-sys-rs |

The shipped Rust tree is 273 crates. 245 of those are available under MIT
and/or Apache-2.0 (some also offering Zlib, 0BSD, Unlicense, or CC0), 18 are
Unicode-3.0, 5 are MPL-2.0, 4 are BSD-family, and 1 (`tao`) is Apache-2.0
alone. The complete list, with exact versions, is `src-tauri/Cargo.lock`;
it can be regenerated with:

```bash
cargo tree -e normal --target aarch64-apple-darwin --prefix none
```

## Fonts

Oxanium is redistributed with the application. `src/index.css` declares it
through two local `@font-face` rules and the files are served from the app's
own origin, so no font is fetched over the network at runtime.

| Component | Files | Licence | Upstream |
| --- | --- | --- | --- |
| Oxanium | `public/fonts/oxanium-latin.woff2`, `public/fonts/oxanium-latin-ext.woff2` | SIL Open Font License 1.1 | https://github.com/sevmeyer/oxanium |

Both files are variable-weight (400-700) WOFF2 subsets of the Original
Version, one covering Latin and one Latin Extended. "Oxanium" is a Reserved
Font Name under the OFL, so any modified derivative must be renamed. The
full licence text is reproduced near the end of this file, because OFL
clause 2 requires the copyright notice and the licence to travel with the
font files in every copy.

No other font is bundled. The monospace and system stacks in `src/App.css`
and `src/FrozenCapture.css` name platform fonts (`ui-monospace`,
`SFMono-Regular`, `Menlo`, `-apple-system`) that are not redistributed.

## Not third-party

`src-tauri/scripts/ocr_vision.swift` and
`src-tauri/scripts/vanilla_shot_recorder.swift` are first-party source in
this repository. They are compiled into the helpers bundled as
`helpers/ocr_vision` and `helpers/vanilla_shot_recorder`, and link only
against Apple system frameworks. They are covered by the project's MIT
licence.

The Raycast extension under `raycast/` depends on `@raycast/api` and
`@raycast/utils`. It is published separately through the Raycast Store and
is not part of the application bundle described above.

---

# Licence texts

## Apache License, Version 2.0

The following applies to every component listed in the "Apache-2.0
components" section above, and to the OCR language model described in the
"OCR language model" section.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright {yyyy} {name of copyright owner}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## MIT License

Representative text for every MIT component listed above. Each project's
own copyright holders and years are stated in its upstream repository.

```
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License

Applies to `lucide-react`.

```
ISC License

Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

## BSD 3-Clause License

Applies to the components listed in the "BSD-licensed components" section.

```
Copyright (c) <year> <copyright holders>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this
   software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Unicode Licence V3

Applies to the ICU4X crates listed in the "Unicode-3.0 components" section.

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2020-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0

—

Portions of ICU4X may have been adapted from ICU4C and/or ICU4J.
ICU 1.8.1 to ICU 57.1 © 1995-2016 International Business Machines Corporation and others.
```

## SIL Open Font License, Version 1.1

Applies to the Oxanium font files under `public/fonts/`. Upstream's
authoritative `OFL.txt` ships alongside the WOFF2 files, as clause 2 of the
licence requires.

```
Copyright 2019 The Oxanium Project Authors (https://github.com/sevmeyer/oxanium)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

Vendored from `mind-ar@1.2.5` (`dist/`), MIT licensed — see LICENSE.

Only the image-tracking `Controller` and `Compiler` are used. Vendored instead of
installed from npm because the package pulls in the native `canvas` module (only
needed for its Node compiler), which fails to build on many machines and CI images.
